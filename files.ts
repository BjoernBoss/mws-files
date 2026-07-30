/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libCrypto from "crypto";
import * as libFs from "fs";
import * as libFsPromises from "fs/promises";
import * as libStream from "stream";
import * as libZlib from "zlib";

const DEFAULT_UPLOAD_LIMIT = 100_000_000;
const MAX_RESERVATION_TIME_MS = 5_000;
const JOB_STATE_TIMEOUT_MS = 180_000;
const WATCHER_GRACE_MS = 30_000;
const WATCHER_COALESCE_PERIOD_MS = 2_000;
const WATCHER_DELETE_CHECK_DELAY_MS = 150;
const VALID_NAME_REGEX = /^[^\x00-\x1f\x7f/\\\?:\*"<>\|]+$/;
const NON_ASCII_REGEX = /[^\x20-\x7e]/;

type FileKind = 'file' | 'directory';
interface DirEntry {
	kind: FileKind;
	size: number;
	modified: number;
}
interface DirListener {
	ws: Set<mws.ClientSocket>;
	grace: NodeJS.Timeout | null;
	delay: NodeJS.Timeout | null;
	defer: NodeJS.Timeout | null;
	children: Map<string, libFs.FSWatcher>;
	close: (reason: string) => Promise<void>;
	settled: boolean;
	stamp: number;
	lastUpdate: number;
	lastState: Record<string, DirEntry>;
}
interface CopyJobEntry {
	progress: number;
	message: string;
	state: 'running' | 'failure' | 'success';
	age: number;
	abort: () => Promise<void>;
}
interface BurntParams {
	access: boolean;
	upload: boolean;
	delete: boolean;
	uploadMTime: boolean;
	uploadLimit: number;
	rebase: string;
}

function makeContentDisposition(name: string): string {
	/* extract the default ascii-name */
	let [_, filename, extension] = mws.splitFileExtension(name);
	if (NON_ASCII_REGEX.test(filename))
		filename = 'download';
	if (!NON_ASCII_REGEX.test(extension))
		filename += extension;
	filename = filename.replace(/(["\\])/g, '\\$1');

	/* [content-disposition] requires more than just the normal percent-encoding */
	const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${filename}"; filename*=UTF-8''${encoded}`;
}

class Zipper {
	/* system: custom/undefined; zip: 4.5 => 45 (zip64 extensions are the highest required feature) */
	private static SystemVersion: number = 96;
	private static ZipVersion: number = 45;
	private static crc32Table: Uint32Array | null = null;
	private static crc32InitTable(): void {
		Zipper.crc32Table = new Uint32Array(256);

		let crc32 = 1;
		for (let i = 128; i; i >>= 1) {
			crc32 = (crc32 >>> 1) ^ ((crc32 & 0x01) ? 0xedb88320 : 0);
			for (let j = 0; j < 256; j += 2 * i)
				Zipper.crc32Table[i + j] = crc32 ^ Zipper.crc32Table[j];
		}
	}
	private static crc32Update(crc32: number, chunk: Buffer): number {
		for (const byte of chunk)
			crc32 = Zipper.crc32Table![(crc32 ^= byte) & 0xff] ^ (crc32 >>> 8);
		return crc32;
	}

	private cleanup: (err: any) => void;
	private failure: any;
	private sink: libStream.Writable;
	private fileOffset: number;
	private entries: Buffer[];
	private closed: boolean;

	public constructor(sink: libStream.Writable) {
		this.cleanup = () => { };
		this.failure = null;
		this.sink = sink;
		this.sink.once('error', (err: any) => {
			this.failure = err;
			this.cleanup(err);
		});
		this.fileOffset = 0;
		this.entries = [];
		this.closed = false;

		/* check if the table needs to be initialized */
		if (Zipper.crc32Table == null)
			Zipper.crc32InitTable();
	}

	private addCommonFileData(buffer: Buffer, offset: number, modified: number, deflate: boolean, descriptor: boolean): number {
		/* zip version, generalPurposeFlag (bit3 for tailing data-descriptor; bit11 for utf-8), compression (0 = none; 8 = deflate) */
		offset = buffer.writeUInt16LE(Zipper.ZipVersion, offset);
		offset = buffer.writeUInt16LE((descriptor ? (0x01 << 3) : 0) | (0x01 << 11), offset);
		offset = buffer.writeUInt16LE((deflate ? 0x08 : 0x00), offset);

		/* last-modification time; last-modification date (clamp the year to the representable range of [1980, 2107]) */
		const date = new Date(modified);
		const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
		offset = buffer.writeUInt16LE((date.getSeconds() / 2) | (date.getMinutes() << 5) | (date.getHours() << 11), offset);
		offset = buffer.writeUInt16LE(date.getDate() | ((date.getMonth() + 1) << 5) | ((year - 1980) << 9), offset);
		return offset;
	}
	private localFileHeader(modified: number, fileName: Buffer, deflate: boolean, directory: boolean): Buffer {
		/* incase of it not being a directory, the size is not yet known, and must be assumed to surpass 32bits) */
		const extSize = (directory ? 0 : 20);
		const out = Buffer.alloc(30 + fileName.length + extSize);
		let offset = 0;

		/* signature (local file header) and the common file-entry data, which are shared with the central directory file header */
		offset = out.writeUInt32LE(0x04034b50, offset);
		offset = this.addCommonFileData(out, offset, modified, deflate, !directory);

		/* crc32, compressed-size, uncompressed-size (all defaulted for data-descriptor mode; set size's to 0xffffffff to indicate zip64) */
		offset = out.writeUInt32LE(0x00, offset);
		offset = out.writeUInt32LE((directory ? 0x00 : 0xffffffff), offset);
		offset = out.writeUInt32LE((directory ? 0x00 : 0xffffffff), offset);

		/* write the file name length and extra field length out and add the filename itself */
		offset = out.writeUInt16LE(fileName.length, offset);
		offset = out.writeUInt16LE(extSize, offset);
		fileName.copy(out, offset);
		offset += fileName.length;

		/* add the zip64 extra field for files to announce the sizes in the data descriptor as being 8-byte values
		*	(the sizes themselves are left as zero, as they are only known once the data descriptor is written) */
		if (!directory) {
			offset = out.writeUInt16LE(0x0001, offset);
			offset = out.writeUInt16LE(16, offset);
			offset = out.writeBigUInt64LE(BigInt(0), offset);
			offset = out.writeBigUInt64LE(BigInt(0), offset);
		}
		return out;
	}
	private addCentralDirectoryFileHeader(modified: number, fileName: Buffer, deflate: boolean, directory: boolean, crc32: number, compressed: number, uncompressed: number, localHeader: number): void {
		/* allocate the necessary buffer */
		const ofSize = (uncompressed >= 0xffffffff), ofCompressed = (compressed >= 0xffffffff), ofOffset = (localHeader >= 0xffffffff);
		const extSize = ((ofSize || ofCompressed || ofOffset) ? 4 + 8 * ((ofSize ? 1 : 0) + (ofCompressed ? 1 : 0) + (ofOffset ? 1 : 0)) : 0);
		const out = Buffer.alloc(46 + fileName.length + extSize);
		let offset = 0;

		/* signature (central directory file header), version made by (system in the upper byte, supported
		*	zip version in the lower), and the common file-entry data, which are shared with the local file header */
		offset = out.writeUInt32LE(0x02014b50, offset);
		offset = out.writeUInt16LE((Zipper.SystemVersion << 8) | Zipper.ZipVersion, offset);
		offset = this.addCommonFileData(out, offset, modified, deflate, !directory);

		/* checksum, compressed-size, uncompressed-size */
		offset = out.writeUInt32LE(crc32, offset);
		offset = out.writeUInt32LE(ofCompressed ? 0xffffffff : compressed, offset);
		offset = out.writeUInt32LE(ofSize ? 0xffffffff : uncompressed, offset);

		/* file-name length, extra-field length, comment length, disk#, internal attr., external attr., local header offset */
		offset = out.writeUInt16LE(fileName.length, offset);
		offset = out.writeUInt16LE(extSize, offset);
		offset = out.writeUInt16LE(0, offset);
		offset = out.writeUInt16LE(0, offset);
		offset = out.writeUInt16LE(0, offset);
		offset = out.writeUInt32LE(0, offset);
		offset = out.writeUInt32LE(ofOffset ? 0xffffffff : localHeader, offset);

		/* write the actual name out and add the extra fields */
		fileName.copy(out, offset);
		offset += fileName.length;
		if (extSize > 0) {
			offset = out.writeUInt16LE(0x0001, offset);
			offset = out.writeUInt16LE(extSize - 4, offset);
			if (ofSize)
				offset = out.writeBigUInt64LE(BigInt(uncompressed), offset);
			if (ofCompressed)
				offset = out.writeBigUInt64LE(BigInt(compressed), offset);
			if (ofOffset)
				offset = out.writeBigUInt64LE(BigInt(localHeader), offset);
		}

		/* write the buffer to the list */
		this.entries.push(out);
	}
	private dataDescriptor(crc32: number, compressed: number, uncompressed: number): Buffer {
		const out = Buffer.alloc(24);
		let offset = 0;

		/* signature (data descriptor), crc32, compressed size, uncompressed size */
		offset = out.writeUInt32LE(0x08074b50, offset);
		offset = out.writeUInt32LE(crc32, offset);
		offset = out.writeBigUInt64LE(BigInt(compressed), offset);
		offset = out.writeBigUInt64LE(BigInt(uncompressed), offset);
		return out;
	}

	public file(path: string, modified: number, data: libStream.Readable, compress: boolean): Promise<void> {
		if (this.closed)
			throw new Error(`End of zip already reached`);
		if (this.failure != null || this.sink.destroyed)
			throw (this.failure ?? new Error(`Zip sink has already been closed`));
		return new Promise<void>(async (resolve, reject) => {
			let settled = false;

			/* register the error and cleanup listener */
			this.cleanup = (err: any) => {
				if (settled) return; settled = true;
				data.destroy(err);
				reject(err);
			};
			data.once('error', (err: any) => {
				if (settled) return; settled = true;
				this.sink.destroy(err);
				reject(err);
			});

			/* encode the path (without the leading slash) and check if it fits into the header (errors will be handled by error callback) */
			const fileName = Buffer.from(path.substring(1), 'utf-8');
			if (fileName.length > 65535)
				return this.sink.destroy(new Error(`Path [${path}] cannot be encoded`));

			/* write the local header out (errors will be handled by error callback) */
			const localHeader = this.localFileHeader(modified, fileName, compress, false);
			await new Promise<void>((res) => this.sink.write(localHeader, () => res()));
			if (this.sink.destroyed) return;

			/* write the actual data to the sink (errors will be handled by error callback) */
			let totalSize = 0, checksum = 0xffffffff;
			let totalCompressed: number | null = null;
			await new Promise<void>((res) => {
				/* create the accumulate transformer to calculate the total size and checksum */
				let stream = data.pipe(new libStream.Transform({
					transform: (chunk, _, cb) => {
						totalSize += chunk.byteLength;
						checksum = Zipper.crc32Update(checksum, chunk);
						cb(null, chunk);
					}
				}));

				/* check if the data should be piped through the compression (zip requires raw deflate without any zlib wrapper) */
				if (compress) {
					totalCompressed = 0;
					const encoder = libZlib.createDeflateRaw();
					const compressed = new libStream.Transform({
						transform: (chunk, _, cb) => {
							totalCompressed += chunk.byteLength;
							cb(null, chunk);
						}
					});

					/* pipe the streams together and register relevant error handlers (to ensure the promise is resolved) */
					stream = stream.pipe(encoder).pipe(compressed);
					encoder.once('error', (e) => this.sink.destroy(new Error(`Encoding error: ${e.message}`)));
					data.once('error', (e) => encoder.destroy(e));
				}

				/* link the full pipeline together and ensure the promise is resolved at some point */
				stream.pipe(this.sink, { end: false });
				stream.once('end', () => {
					data.unpipe();
					stream.unpipe();
					res();
				});
				data.once('error', () => stream.end());
			});
			if (this.sink.destroyed) return;
			if (totalCompressed == null)
				totalCompressed = totalSize;

			/* finalize the checksum and ensure its unsigned and write the data descriptor out (errors will be handled by error callback) */
			checksum = (checksum ^ 0xffffffff) >>> 0;
			const dataDescriptor = this.dataDescriptor(checksum, totalCompressed, totalSize);
			await new Promise<void>((res) => this.sink.write(dataDescriptor, () => res()));
			if (this.sink.destroyed) return;

			/* add central directory file header and update the file offset */
			this.addCentralDirectoryFileHeader(modified, fileName, compress, false, checksum, totalCompressed, totalSize, this.fileOffset);
			this.fileOffset += localHeader.byteLength + totalCompressed + dataDescriptor.byteLength;
			settled = true;
			resolve();
		});
	}
	public directory(path: string, modified: number): Promise<void> {
		if (this.closed)
			throw new Error(`End of zip already reached`);
		if (this.failure != null || this.sink.destroyed)
			throw (this.failure ?? new Error(`Zip sink has already been closed`));
		return new Promise<void>(async (resolve, reject) => {
			let settled = false;

			/* register the error and cleanup listener */
			this.cleanup = (err: any) => {
				if (settled) return; settled = true;
				reject(err);
			};

			/* encode the path (without the leading slash but with trailing slash) and check
			*	if it fits into the header (errors will be handled by error callback) */
			const fileName = Buffer.from(`${path.substring(1)}/`, 'utf-8');
			if (fileName.length > 65535)
				return this.sink.destroy(new Error(`Path [${path}/] cannot be encoded`));

			/* write the local header out (errors will be handled by error callback) */
			const localHeader = this.localFileHeader(modified, fileName, false, true);
			await new Promise<void>((res) => this.sink.write(localHeader, () => res()));
			if (this.sink.destroyed) return;

			/* add central directory file header and update the file offset */
			this.addCentralDirectoryFileHeader(modified, fileName, false, true, 0, 0, 0, this.fileOffset);
			this.fileOffset += localHeader.byteLength;
			settled = true;
			resolve();
		});
	}
	public close(): Promise<void> {
		if (this.closed)
			throw new Error(`End of zip already reached`);
		if (this.failure != null || this.sink.destroyed)
			throw (this.failure ?? new Error(`Zip sink has already been closed`));
		this.closed = true;

		return new Promise<void>(async (resolve, reject) => {
			let settled = false;

			/* register the error and cleanup listener */
			this.cleanup = (err: any) => {
				if (settled) return; settled = true;
				reject(err);
			};

			/* write out the central directory (errors will be handled by error callback) */
			const central = Buffer.concat(this.entries);
			await new Promise<void>((res) => this.sink.write(central, () => res()));
			if (this.sink.destroyed) return;

			/* allocate the buffer for the zip64 end of central directory record & locator and the original end */
			const buffer = Buffer.alloc(56 + 20 + 22);
			let offset = 0;

			/* record: signature, sizeof (header - initial fields), version made by, version needed to extract */
			offset = buffer.writeUInt32LE(0x06064b50, offset);
			offset = buffer.writeBigUInt64LE(BigInt(56 - 12), offset);
			offset = buffer.writeUInt16LE((Zipper.SystemVersion << 8) | Zipper.ZipVersion, offset);
			offset = buffer.writeUInt16LE(Zipper.ZipVersion, offset);

			/* record: disk#, start disk#, entries on this disk, total entries */
			offset = buffer.writeUInt32LE(0, offset);
			offset = buffer.writeUInt32LE(0, offset);
			offset = buffer.writeBigUInt64LE(BigInt(this.entries.length), offset);
			offset = buffer.writeBigUInt64LE(BigInt(this.entries.length), offset);

			/* record: size central-directory, offset central-directory */
			offset = buffer.writeBigUInt64LE(BigInt(central.byteLength), offset);
			offset = buffer.writeBigUInt64LE(BigInt(this.fileOffset), offset);

			/* locator: signature, start disk#, offset of zip64 end of central directory record, total disk# */
			offset = buffer.writeUInt32LE(0x07064b50, offset);
			offset = buffer.writeUInt32LE(0, offset);
			offset = buffer.writeBigUInt64LE(BigInt(this.fileOffset + central.byteLength), offset);
			offset = buffer.writeUInt32LE(1, offset);

			/* original: signature, disk#, start disk#, entries on disk, total entries */
			offset = buffer.writeUInt32LE(0x06054b50, offset);
			offset = buffer.writeUInt16LE(0xffff, offset);
			offset = buffer.writeUInt16LE(0xffff, offset);
			offset = buffer.writeUInt16LE(0xffff, offset);
			offset = buffer.writeUInt16LE(0xffff, offset);

			/* original: sizeof central directory, offset central-directory, comment-length */
			offset = buffer.writeUInt32LE(0xffffffff, offset);
			offset = buffer.writeUInt32LE(0xffffffff, offset);
			offset = buffer.writeUInt16LE(0, offset);

			/* write the end of central directory (errors will be handled by error callback) */
			await new Promise<void>((res) => this.sink.end(buffer, () => res()));
			if (!settled) {
				settled = true;
				resolve();
			}
		});
	}
}

/**
 *	Parameter are created by merging the handler-params as Params with the default parameter.
 *	The properties decide whether or not a given client has access to the
 *	corresponding abilities (otherwise results in 403), or how the module should behave.
 *	Note: Params should be the same for any request of a given client into a common rebase path,
 *		as the frontend will use the parameter for any path operations within the sub-tree.
 */
export interface Params {
	/** connection is allowed to access content (default: false) */
	access?: boolean;

	/** connection is allowed to upload content (default: false) */
	upload?: boolean;

	/** connection is allowed to delete content (default: false) */
	delete?: boolean;

	/** preserve the mtime of uploaded content, otherwise reset to current time (default: false) */
	uploadMTime?: boolean;

	/** largest content to copy or upload (0 implies no limit; default: 100MB) */
	uploadLimit?: number;

	/** rebase the connections root to a sub-directory, thereby limiting all of its moves (must be a directory; default: '/') */
	rebase?: string;
}

/**
 *	Endpoints used by the module.
 *	This mapping can be used to translate components of the module to different paths in the URL space.
 *
 *	All paths in the url or http header use URI encoding for the components, while preserving '/'.
 *	All paths in json format are not encoded.
 *	Note: Endpoints should be the same for any request of a given client into a common rebase path,
 *		as the frontend will use the endpoints for any path operations within the sub-tree.
 */
export const Endpoints = {
	/** directory containing static assets (sparsely used) */
	static: '/static',

	/** directory for raw files and directory listings and views (GET; POST/PUT require
	 *	Params.upload; DELETE and moving require Params.delete; all require Params.access) */
	files: '/files',

	/** directory for copy jobs (GET; requires Params.access) */
	jobs: '/jobs',

	/** directory for web-sockets for change listener (requires Params.access) */
	sockets: '/ws'
}

/**
 *	The FileShare caches path reservations and copy jobs internally, no two shares should be mapped to the same directory at the same time.
 */
export class FileShare extends mws.ModuleHandler {
	private fileStorage: (path: string) => string;
	private fileStatic: (path: string) => string;
	private fileAssets: (path: string) => string;
	private listener: Record<string, DirListener>;
	private reservations: {
		timeout: NodeJS.Timeout | null;
		entries: Record<string, { age: number, id: string }>;
	};
	private copyJobs: {
		timeout: NodeJS.Timeout | null;
		entries: Record<string, CopyJobEntry>;
	}
	private defaultParams: BurntParams;

	/**
	 *	[dataPath] path to all of the directories and files to be served (must be the path to a directory).
	 *	[params] describes the default parameter.
	 */
	constructor(dataPath: string, params?: Params) {
		super('files');

		this.fileStorage = mws.createPathLocation(dataPath);
		this.fileStatic = mws.createPathSelf(import.meta.url, '../static');
		this.fileAssets = mws.createPathSelf(import.meta.url, '../assets');
		this.listener = {};
		this.reservations = { timeout: null, entries: {} };
		this.copyJobs = { timeout: null, entries: {} };
		this.defaultParams = {
			access: params?.access ?? false,
			upload: params?.upload ?? false,
			delete: params?.delete ?? false,
			uploadLimit: params?.uploadLimit ?? DEFAULT_UPLOAD_LIMIT,
			uploadMTime: params?.uploadMTime ?? false,
			rebase: mws.sanitize(params?.rebase ?? '/', false)
		};
	}

	private triggerCheckReservations(): void {
		if (this.reservations.timeout != null)
			return;
		this.reservations.timeout = setTimeout(() => {
			this.reservations.timeout = null;

			/* remove all outdated reservations */
			let time = Date.now(), remaining = false;
			for (const key in this.reservations.entries) {
				if (time - this.reservations.entries[key].age > MAX_RESERVATION_TIME_MS)
					delete this.reservations.entries[key];
				else
					remaining = true;
			}

			/* check if another cleanup needs to be scheduled */
			if (remaining)
				this.triggerCheckReservations();
		}, MAX_RESERVATION_TIME_MS);
	}
	private triggerCheckJobs(): void {
		if (this.copyJobs.timeout != null)
			return;
		this.copyJobs.timeout = setTimeout(() => {
			this.copyJobs.timeout = null;

			/* remove all outdated resolved jobs (running jobs will start the cleanup timer themselves) */
			let time = Date.now(), remaining = false;
			for (const key in this.copyJobs.entries) {
				if (this.copyJobs.entries[key].state == 'running')
					continue;
				if (time - this.copyJobs.entries[key].age > JOB_STATE_TIMEOUT_MS)
					delete this.copyJobs.entries[key];
				else
					remaining = true;
			}

			/* check if another cleanup needs to be scheduled */
			if (remaining)
				this.triggerCheckJobs();
		}, JOB_STATE_TIMEOUT_MS);
	}
	private checkOrUseReservation(client: mws.ClientRequest, filePath: string, reservation: string): boolean {
		if (!(filePath in this.reservations.entries))
			return true;

		/* check if the given reservation is outdated or this owner */
		if (Date.now() - this.reservations.entries[filePath].age <= MAX_RESERVATION_TIME_MS && this.reservations.entries[filePath].id != reservation) {
			client.respondConflict({ message: `Path has been reserved` });
			return false;
		}

		/* remove the existing reservation */
		delete this.reservations.entries[filePath];
		return true;
	}
	private async checkParentState(client: mws.ClientRequest, filePath: string, parentIsRoot: boolean): Promise<boolean> {
		const parentPath = mws.joinNative(filePath, '..');

		try {
			/* check if the parent directory exists */
			const stats = await libFsPromises.stat(parentPath);
			if (stats.isDirectory())
				return true;

			if (!parentIsRoot && stats.isFile()) {
				client.respondConflict({ message: 'Parent is not a directory' });
				return false;
			}

			if (!stats.isDirectory() && !stats.isFile())
				this.warning(`Unsupported file-system object encountered: ${parentPath}`);
		} catch (_) { }

		/* errors or bad type is considered to not exist */
		if (parentIsRoot)
			client.respondInternalError('Root does not exist');
		else
			client.respondConflict({ message: 'Parent does not exist' });
		return false;
	}
	private async tryReservePath(client: mws.ClientRequest, filePath: string, parentIsRoot: boolean, reservation: string, silent: boolean): Promise<string | null> {
		/* check if the path is already reserved */
		if (!this.checkOrUseReservation(client, filePath, reservation))
			return null;

		/* already insert the new reservation (to ensure no race condition while applying) */
		const id = libCrypto.randomUUID();
		this.reservations.entries[filePath] = { id, age: Date.now() };
		this.triggerCheckReservations();
		client.trace(`Reserved path [${filePath}] under id [${id}]`);

		const result = await (async (): Promise<boolean> => {
			try {
				/* check if the path already exists (for a silent check, dont reserve the path anymore) */
				const stat = await libFsPromises.stat(filePath);
				if (silent && stat.isDirectory()) {
					client.respondOk({ message: 'Already exists' });
					return false;
				}

				if (!stat.isDirectory() && !stat.isFile())
					this.warning(`Unsupported file-system object encountered: ${filePath}`);
				client.respondConflict({ message: `Path already exists` });
				return false;
			}
			catch (err: any) {
				if (err.code != 'ENOENT') {
					client.respondInternalError(`Failed to reserve [${filePath}]: ${err.message}`);
					return false;
				}

				/* check if the parent directory exists */
				return this.checkParentState(client, filePath, parentIsRoot);
			}
		})();

		/* return the id or cleanup the temporary reservation */
		if (result)
			return id;
		if (this.reservations.entries[filePath]?.id == id)
			delete this.reservations.entries[filePath];
		return null;
	}
	private async checkPathKind(client: mws.ClientRequest, filePath: string, kind: FileKind): Promise<boolean> {
		/* let errors propagate out */
		const stats = await libFsPromises.stat(filePath);
		if (!stats.isFile() && !stats.isDirectory()) {
			this.warning(`Unsupported file-system object encountered: ${filePath}`);
			client.respondNotFound();
			return false;
		}

		if (!(kind == 'directory' ? stats.isDirectory() : stats.isFile())) {
			client.respondConflict({ message: `Path is not a ${kind}` });
			return false;
		}
		return true;
	}
	private encodePath(path: string): string {
		return path.split('/').map((val) => encodeURIComponent(val)).join('/');
	}
	private decodePath(client: mws.ClientRequest, path: string): string | null {
		if (path == '/')
			return path;
		let out = '';

		/* iterate over the path components (path can already only contain '/'; and URI-decode them) */
		for (let i = 1; i < path.length;) {
			let end = path.indexOf('/', i);
			if (end < 0)
				end = path.length;

			/* uri decode the component and add it to the built path */
			try {
				const next = decodeURIComponent(path.substring(i, end));
				if (next.match(VALID_NAME_REGEX)) {
					out += `/${next}`, i = end + 1;
					continue;
				}

				client.respondBadRequest({ message: `Invalid path component [${next}]` });
			} catch (_) {
				client.respondBadRequest({ message: `Invalid path encoding` });
			}
			return null;
		}

		return mws.sanitize(out, false);
	}
	private async fetchDirectoryList(filePath: string): Promise<Record<string, DirEntry>> {
		const out: Record<string, DirEntry> = {};

		/* collect all of the meta data about the directory (let errors propagate out; silently ignore errors) */
		for (const name of await libFsPromises.readdir(filePath)) {
			const childPath = `${filePath}/${name}`;
			try {
				const stats = await libFsPromises.stat(childPath);

				if (stats.isFile())
					out[name] = { kind: 'file', size: stats.size, modified: stats.mtimeMs };
				else if (stats.isDirectory())
					out[name] = { kind: 'directory', size: (await libFsPromises.readdir(childPath)).length, modified: stats.mtimeMs };
				else
					this.warning(`Unsupported file-system object encountered: ${childPath}`);
			}
			catch (err: any) {
				this.warning(`Error fetching information about directory entry [${childPath}]: ${err.message}`);
			}
		}
		return out;
	}
	private async handleUpload(client: mws.ClientRequest, filePath: string, kind: FileKind, parentIsRoot: boolean, params: BurntParams): Promise<void> {
		if (!params.upload)
			return client.respondForbidden({ reason: 'Not allowed to upload content' });

		let reservation = client.url.searchParams.get('reservation') ?? '';
		const mtime = (params.uploadMTime ? parseInt(client.url.searchParams.get('mtime') ?? '') : NaN);
		const silent = (kind == 'directory' && client.url.searchParams.get('silent') == 'true');
		const reserve = (client.url.searchParams.get('reserve') == 'true');

		try {
			/* check if the path is to be reserved or is already reserved (failure to reserve will automatically respond) */
			if (reserve) {
				const id = await this.tryReservePath(client, filePath, parentIsRoot, reservation, silent);
				if (id != null)
					client.respondOk({ message: 'Reservation registered', headers: { 'Reservation-Id': id } });
				return;
			}
			if (!this.checkOrUseReservation(client, filePath, reservation))
				return;

			/* check if a directory is to be created */
			if (kind == 'directory') {
				await libFsPromises.mkdir(filePath, { recursive: false });

				/* try to update the mtime, but dont fail on any errors */
				if (!isNaN(mtime)) {
					try { await libFsPromises.utimes(filePath, mtime / 1000, mtime / 1000); }
					catch (err: any) { client.error(`Failed updating mtime of [${filePath}]: ${err.message}`) };
				}
				return client.respondOk({ message: `Directory created` });
			}

			/* try to upload the file (automatically enforces upload-size constraint) */
			await this.cache.write(filePath, client.receiveData(params.uploadLimit == 0 ? null : params.uploadLimit), { create: true, mtime: (isNaN(mtime) ? undefined : mtime) });
			return client.respondOk({ message: `File uploaded` });
		}
		catch (err: any) {
			if (err.code == 'ENOENT') {
				if (await this.checkParentState(client, filePath, parentIsRoot))
					client.respondConflict({ message: 'Path removed mid operation' });
				return;
			}
			if (err.code != 'EEXIST')
				return client.respondInternalError(`Failed to create ${kind} [${filePath}]: ${err.message}`);

			/* check if the directory already existed and should fail silently */
			if (silent) {
				try {
					if ((await libFsPromises.stat(filePath)).isDirectory())
						return client.respondOk({ message: `Already exists` });
				} catch (_) { }
			}
			return client.respondConflict({ message: `Path already exists` });
		}
	}
	private async handleCopy(client: mws.ClientRequest, filePath: string, fileTarget: string, reservation: string, params: BurntParams): Promise<void> {
		let stream: mws.FileReadable | null = null;
		const success = ((): boolean => {
			try {
				/* open the source file for reading */
				stream = this.cache.stream(filePath, { checkFreshness: true, eager: true });
				if (stream == null) {
					client.respondNotFound();
					return false;
				}

				/* validate the size constraints (must destroy the stream) */
				if (params.uploadLimit != 0 && stream.fileSize > params.uploadLimit) {
					client.respondContentTooLarge(params.uploadLimit, stream.fileSize);
					return false;
				}
			} catch (err: any) {
				client.respondInternalError(`Failed to copy [${filePath}] to [${fileTarget}]: ${err.message}`);
				return false;
			}
			let resolver = () => { };
			const completed: Promise<void> = new Promise((res) => resolver = res);

			/* allocate the new job of uncertain running state (abort by destroying the transformer,
			*	the erroring write will resolve the completed promise and clean the target up) */
			const job = libCrypto.randomUUID();
			const entry: CopyJobEntry = this.copyJobs.entries[job] = {
				abort: async () => {
					if (entry.state == 'running')
						transform.destroy(new Error('Copy aborted'));
					await completed;
					if (job in this.copyJobs.entries)
						delete this.copyJobs.entries[job];
				},
				age: 0,
				progress: 0,
				message: '',
				state: 'running'
			};

			/* setup the intermediate transformer to update the progress (ignore pipeline
			*	errors, as the cache.write will already return them properly) */
			let processed = 0;
			const transform = new libStream.Transform({
				transform: (chunk, _, cb) => {
					processed += chunk.byteLength;
					entry.progress = (stream!.fileSize > 0 ? Math.min(1, processed / stream!.fileSize) : 1);
					cb(null, chunk);
				}
			});
			libStream.pipeline(stream, transform, () => { });

			/* start writing the file while preserving the source modified-time (detach the execution as the job may take longer) */
			this.cache.write(fileTarget, transform, { create: true, mtime: stream.timeModified })
				.then(() => {
					this.log(`Copy job [${job}] completed`);

					/* mark the job as completed */
					entry.progress = 1.0;
					entry.state = 'success';
					entry.age = Date.now();
					this.triggerCheckJobs();
					resolver();
				})
				.catch((err: any) => {
					if (this.reservations.entries[fileTarget]?.id == reservation)
						delete this.reservations.entries[fileTarget];
					this.error(`Error in copy job [${job}]: ${err.message}`);

					/* mark the job as decided */
					entry.state = 'failure';
					entry.age = Date.now();
					this.triggerCheckJobs();
					resolver();
					if (err.code == 'EEXIST')
						entry.message = 'Path already exists';
					else if (err.code == 'ENOENT')
						entry.message = 'Path removed mid operation';
					else
						entry.message = 'Internal server error';
				});

			/* return the newly created job-id */
			this.log(`Create copy job for [${filePath}] to [${fileTarget}] under id [${job}]`);
			client.respondOk({ message: 'Copy job created', headers: { 'Job-Id': job } });
			return true;
		})();

		/* perform any necessary cleanup (will already have been responded) */
		if (success)
			return;
		if (this.reservations.entries[fileTarget]?.id == reservation)
			delete this.reservations.entries[fileTarget];
		if (stream != null)
			stream.destroy();
	}
	private async handleCopyMove(client: mws.ClientRequest, filePath: string, kind: FileKind, params: BurntParams): Promise<void> {
		if (!params.upload)
			return client.respondForbidden({ reason: 'Not allowed to upload content' });

		const isCopy = client.url.searchParams.has('copy');
		if (isCopy && client.url.searchParams.has('move'))
			return client.respondBadRequest({ message: 'Copy and move are mutually exclusive operations' });
		if (!isCopy && !client.url.searchParams.has('move'))
			return client.respondBadRequest({ message: 'PUT requires operation target' });

		if (!isCopy && !params.delete)
			return client.respondForbidden({ reason: 'Not allowed to delete content' });
		if (isCopy && kind != 'file')
			return client.respondBadRequest({ message: `${kind[0].toUpperCase()}${kind.substring(1)} cannot be copied` });

		/* validate the target path (query parameters are received decoded, hence only sanitize the path and validate its components) */
		const target = mws.sanitize(client.url.searchParams.get(isCopy ? 'copy' : 'move')!, false);
		if (target == '/')
			return client.respondForbidden({ message: `Root cannot be a ${isCopy ? 'copy' : 'move'} target` });
		for (const name of target.substring(1).split('/')) {
			if (!name.match(VALID_NAME_REGEX))
				return client.respondBadRequest({ message: `Invalid path component [${name}]` });
		}
		const fileTarget = this.fileStorage(mws.joinSanitized(params.rebase, target));

		/* validate the source kind (ignore any race conditions, if the path is modified up to the actual operation) */
		try {
			if (!await this.checkPathKind(client, filePath, kind))
				return;
		} catch (err: any) {
			if (err.code == 'ENOENT')
				return client.respondNotFound();
			return client.respondInternalError(`Failed to ${isCopy ? 'copy' : 'move'} [${filePath}]: ${err.message}`);
		}

		/* validate and reserve the destination (ensures parent exists and name cannot be used again) */
		const reservation = await this.tryReservePath(client, fileTarget, (mws.splitFileName(target)[0] == '/'), (client.url.searchParams.get('reservation') ?? ''), false);
		if (reservation == null)
			return;

		/* check if its a copy operation and perform it */
		if (isCopy)
			return this.handleCopy(client, filePath, fileTarget, reservation, params);

		/* perform the move operation */
		try {
			await libFsPromises.rename(filePath, fileTarget);
			client.respondOk({ message: `${kind[0].toUpperCase()}${kind.substring(1)} successfully moved` });
		}
		catch (err: any) {
			if (err.code == 'ENOENT')
				client.respondNotFound();
			else
				client.respondInternalError(`Failed to move [${filePath}] to [${fileTarget}]: ${err.message}`);
		}

		/* clear the destination reservation */
		if (this.reservations.entries[fileTarget]?.id == reservation)
			delete this.reservations.entries[fileTarget];
		return;
	}
	private async handleDelete(client: mws.ClientRequest, filePath: string, kind: FileKind, params: BurntParams): Promise<void> {
		if (!params.delete)
			return client.respondForbidden({ reason: 'Not allowed to delete content' });

		/* try to remove the object */
		try {
			if (kind == 'directory')
				await libFsPromises.rmdir(filePath);
			else if (!await this.cache.remove(filePath))
				return client.respondNotFound();
			client.respondOk({ message: `${kind[0].toUpperCase()}${kind.substring(1)} successfully deleted` });
		}
		catch (err: any) {
			if (kind == 'directory' && err.code == 'ENOTEMPTY')
				return client.respondConflict({ message: 'Directory not empty' });

			/* check if its a kind mis-match */
			try {
				if (!await this.checkPathKind(client, filePath, kind))
					return;
			}
			catch (_err: any) {
				if (_err.code == 'ENOENT')
					return client.respondNotFound();
			}
			client.respondInternalError(`Failed to remove ${kind} [${filePath}]: ${err.message}`);
		}
	}
	private async handleDownload(client: mws.ClientRequest, filePath: string, headers: Record<string, string>, list: Record<string, DirEntry>): Promise<void> {
		client.log(`Zipping directory [${filePath}]`);

		/* prepare writing the directory content to a zip file and create the zipper (automatically handles errors and
		*	closes connection) or immediately respond, if its only a head request and no content needs to be produced */
		const writer = client.respondData({ media: mws.Media.Zip, headers });
		if (client.isHead) {
			writer.once('error', () => { });
			return new Promise<void>((resolve) => writer.end(() => resolve()));
		}
		const zipper = new Zipper(writer);

		/* helper to process directory (let errors propagate out) */
		const process = async (path: string, entries: Record<string, DirEntry>): Promise<void> => {
			for (const name in entries) {
				const entry = entries[name], relativePath = `${path}/${name}`;
				const absolutePath = mws.joinNative(filePath, relativePath);

				/* check if a file is to be added (skip removed files) */
				if (entry.kind == 'file') {
					const stream = this.cache.stream(absolutePath, { checkFreshness: true });
					if (stream != null) {
						const compressed = ((mws.lookupMediaTypeFromFile(name)?.compressible ?? false) && entry.size >= mws.MIN_ENCODING_SIZE);
						client.trace(`Adding [${absolutePath}] of size ${entry.size} to zip at [${relativePath}]${compressed ? ' (deflated)' : ''}`);
						await zipper.file(relativePath, entry.modified, stream, compressed);
					}
				}

				/* add the directory entry and process the children */
				else {
					client.trace(`Adding [${absolutePath}] to zip at [${relativePath}]`);
					await zipper.directory(relativePath, entry.modified);
					const children = await this.fetchDirectoryList(absolutePath);
					await process(relativePath, children);
				}
			}
		};

		/* process the root directory and close the zipper (ensure the response stream is
		*	properly destroyed on errors, as the zip cannot be completed anymore) */
		try {
			await process('', list);
			await zipper.close();
		}
		catch (err: any) {
			this.error(`Failed to zip directory [${filePath}]: ${err.message}`);
			writer.destroy(err);
		}
	}
	private async handleFiles(client: mws.ClientRequest, path: string, params: BurntParams): Promise<void> {
		const filePath = this.fileStorage(mws.joinSanitized(params.rebase, path));

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'PUT', 'DELETE']);
		if (method == null)
			return;

		/* validate the request kind */
		const kind = client.url.searchParams.get('kind');
		if (kind != null && kind != 'file' && kind != 'directory')
			return client.respondBadRequest({ message: `Unsupported kind [${kind}] encountered` });

		/* check if the method is allowed for the given endpoint (rebased-root cannot be modified) */
		if (path == '/') {
			if (method != 'GET')
				return client.respondForbidden({ message: 'Root cannot be modified' });
			if (kind == 'file')
				return client.respondConflict({ message: 'Root is a directory' });
		}

		/* check if the entry is to be deleted or uploaded or moved */
		if (method == 'POST')
			return this.handleUpload(client, filePath, (kind ?? 'file'), (mws.splitFileName(path)[0] == '/'), params);
		if (method == 'PUT')
			return this.handleCopyMove(client, filePath, (kind ?? 'file'), params);
		if (method == 'DELETE')
			return this.handleDelete(client, filePath, (kind ?? 'file'), params);

		/* try to serve it as a file (rebased-root cannot be served as a file) */
		if ((kind == null || kind == 'file') && path != '/') {
			const headers: Record<string, string> = { 'Kind': 'file', 'Path': this.encodePath(path) };

			/* check if its supposed to be a download */
			if (client.url.searchParams.get('download') == 'true')
				headers['Content-Disposition'] = makeContentDisposition(mws.splitFileName(path)[1]);

			/* try to perform the actual serving (check freshness at all times, as the file might be changed) */
			if (await client.tryRespondFile(filePath, { checkFreshness: true, headers }))
				return;
		}

		/* try to serve it as a directory */
		if (kind == null || kind == 'directory') {
			try {
				const headers: Record<string, string> = { 'Kind': 'directory', 'Path': this.encodePath(path) };

				/* try to read the directory state (for the root, any reading error is
				*	considered an internal server error, as it is expected to exist) */
				let list: Record<string, DirEntry> = {};
				try { list = await this.fetchDirectoryList(filePath); }
				catch (err: any) {
					if (path != '/')
						throw err;
					return client.respondInternalError(`Root [${filePath}] error: ${err.message}`);
				}

				/* check if the directory is to be downloaded */
				if (client.url.searchParams.get('download') == 'true') {
					const [_, name] = mws.splitFileName(path);
					headers['Content-Disposition'] = makeContentDisposition(`${name == '' ? 'directory' : name}.zip`);
					return this.handleDownload(client, filePath, headers, list);
				}

				/* check if the directory should be served in raw and otherwise create the directory view */
				if (client.url.searchParams.get('raw') == 'true')
					return client.respondJson(list, { headers });
				return this.buildView(client, path, list, params);
			} catch (err: any) {
				if (err.code == 'ENOENT')
					return client.respondNotFound();
				if (err.code != 'ENOTDIR')
					return client.respondInternalError(`Failed to serve path [${filePath}]: ${err.message}`);
			}
		}

		/* check if its an unsupported kind (if the kind matches now, it must be a race condition: ignore) */
		try {
			if (!await this.checkPathKind(client, filePath, kind ?? 'file'))
				return;
		} catch (_) { }
		return client.respondNotFound();
	}
	private staticPath(client: mws.ClientRequest, path: string): string {
		return client.makeImmutable(this.name, mws.joinSanitized(Endpoints.static, path));
	}
	private async buildView(client: mws.ClientRequest, path: string, list: Record<string, DirEntry>, params: BurntParams): Promise<void> {
		/* fetch the content of the main view */
		const fullPath = this.fileAssets('/page.html');
		let body: string | null = null;
		try {
			const data: Buffer | null = await this.cache.read(fullPath);
			if (data == null)
				return client.respondInternalError(`Failed to find content [${fullPath}]`);
			body = data.toString('utf-8');
		}
		catch (err: any) {
			return client.respondInternalError(`Failed to read content [${fullPath}]: ${err.message}`);
		}

		const loadParams: string = JSON.stringify({
			delete: params.delete,
			upload: params.upload,
			uploadLimit: params.uploadLimit,
			path,
			files: client.makePath(Endpoints.files),
			jobs: client.makePath(Endpoints.jobs),
			sockets: client.makePath(Endpoints.sockets),
			icons: {
				back: this.staticPath(client, '/back-icon.svg'),
				close: this.staticPath(client, '/close-icon.svg'),
				create: this.staticPath(client, '/create-icon.svg'),
				delete: this.staticPath(client, '/delete-icon.svg'),
				download: this.staticPath(client, '/download-icon.svg'),
				directory: this.staticPath(client, '/directory-icon.svg'),
				file: this.staticPath(client, '/file-icon.svg'),
				rename: this.staticPath(client, '/rename-icon.svg'),
				copy: this.staticPath(client, '/copy-icon.svg'),
				move: this.staticPath(client, '/move-icon.svg'),
				open: this.staticPath(client, '/open-icon.svg'),
				clipboard: this.staticPath(client, '/clipboard-icon.svg'),
				upload: this.staticPath(client, '/upload-icon.svg'),
				home: this.staticPath(client, '/home-icon.svg'),
				menu: this.staticPath(client, '/menu-icon.svg')
			},
			content: list
		});
		const title = mws.splitFileName(path)[1];

		/* add the required page headers and load the content from cache */
		const b = mws.build;
		const page = new b.HtmlPage({
			language: 'en',
			head: [
				b.Meta('viewport', 'width=device-width, initial-scale=1'),
				b.Title(title == '' ? 'Root Directory' : `Directory: ${title}`),
				b.Meta('Description', `Content of directory ${path}`),
				b.LoadStyle(this.staticPath(client, '/style.css')),
				b.LoadScript(this.staticPath(client, '/main.js')),
				b.AddScript(`__LOAD_PARAMS__=${loadParams}`)
			],
			body: b.Embed(body, true)
		});
		client.respondHtml(page);
	}
	private acceptWebSocket(client: mws.ClientSocket, path: string): void {
		/* check if the listener needs to be created (path will already be fully expanded) */
		if (!(path in this.listener)) {
			const filePath = this.fileStorage(path);
			try {
				/* ensure that the watched path is a directory */
				const stats = libFs.statSync(filePath);
				if (!stats.isDirectory())
					throw new Error(`Can only watch directories`);
				this.info(`Started listening for changes: [${filePath}]`);

				/* on watcher errors, delay the cleanup, as a removal of the directory might result in a race condition,
				*	where watching fails, but the stats still show the directory to exist, thus resulting in the wrong error */
				const watcher = libFs.watch(filePath);
				watcher.on('change', () => triggered());
				watcher.on('error', (err: any) => cleanup(err, true));

				const entry: DirListener = {
					grace: null,
					delay: null,
					defer: null,
					stamp: 0,
					lastUpdate: Date.now() - WATCHER_COALESCE_PERIOD_MS,
					ws: new Set<mws.ClientSocket>(),
					children: new Map<string, libFs.FSWatcher>(),
					close: async (reason: string): Promise<void> => {
						delete this.listener[path];
						entry.settled = true;
						watcher.close();
						this.info(`Stopping listening for changes: [${filePath}]`);

						/* close all of the child watchers */
						for (const child of entry.children.values())
							child.close();
						entry.children.clear();

						/* close any open timers */
						if (entry.grace != null)
							clearTimeout(entry.grace);
						if (entry.delay != null)
							clearTimeout(entry.delay);
						if (entry.defer != null)
							clearTimeout(entry.defer);

						/* close all sockets */
						const promises: Promise<void>[] = [];
						for (const ws of entry.ws) {
							ws.send(reason);
							promises.push(ws.close());
						}
						entry.ws.clear();

						await Promise.all(promises);
					},
					settled: false,
					lastState: {}
				};
				this.listener[path] = entry;

				/* synchronize the child watchers with the given directory state (changes within immediate
				*	sub-directories modify the listed metadata (item count and modified time) but do not trigger
				*	the main watcher on all platforms; child errors are non-fatal, as any structural change
				*	of the child will trigger the main watcher, which re-synchronizes the child watchers) */
				const syncChildren = (list: Record<string, DirEntry>) => {
					for (const [name, child] of entry.children) {
						if (list[name]?.kind == 'directory')
							continue;
						child.close();
						entry.children.delete(name);
					}
					for (const name in list) {
						if (list[name].kind != 'directory' || entry.children.has(name))
							continue;
						try {
							const child = libFs.watch(mws.joinNative(filePath, name));
							child.on('change', () => triggered());
							child.on('error', () => {
								child.close();
								if (entry.children.get(name) == child)
									entry.children.delete(name);
							});
							entry.children.set(name, child);
						} catch (_) { }
					}
				};
				const checkStatesEqual = (a: Record<string, DirEntry>, b: Record<string, DirEntry>): boolean => {
					const aKeys = Object.keys(a), bKeys = Object.keys(b);
					if (aKeys.length != bKeys.length)
						return false;

					for (const key of aKeys) {
						if (!(key in b))
							return false;
						const aEntry = a[key], bEntry = b[key];

						if (aEntry.kind != bEntry.kind || aEntry.modified != bEntry.modified || aEntry.size != bEntry.size)
							return false;
					}
					return true;
				};
				const cleanup = (err: any, delay: boolean) => {
					if (entry.settled) return;

					if (delay && entry.delay == null) {
						entry.delay = setTimeout(() => cleanup(err, false), WATCHER_DELETE_CHECK_DELAY_MS);
						return;
					}

					/* check if the path has been removed */
					let removed = false;
					try { removed = !libFs.statSync(filePath).isDirectory(); }
					catch (_err: any) { removed = (_err.code == 'ENOENT'); }

					this.error(`Error while watching ${removed ? 'removed ' : ''}path [${filePath}]: ${err.message}`);
					entry.close(removed ? 'removed' : 'error');
				};
				const changed = (broadcast: boolean) => {
					if (entry.settled) return;
					if (broadcast)
						entry.lastUpdate = Date.now(), entry.defer = null;
					const stamp = ++entry.stamp;

					/* fetch the new directory state to be broadcasted and re-synchronize the child
					*	watchers (discard outdated states, if another change has started in the meantime) */
					this.fetchDirectoryList(filePath).then((list) => {
						if (entry.settled || entry.stamp != stamp)
							return;
						syncChildren(list);
						if (!broadcast) return;

						/* check if the state has actually changed (to prevent irrelvant updates, which
						*	can happen, if a single change is triggered as two consecutive events) */
						if (checkStatesEqual(list, entry.lastState))
							return;

						entry.lastState = list;
						this.trace(`Notifying listener about directory change: [${filePath}]`);

						const state = JSON.stringify(list);
						for (const ws of entry.ws)
							ws.send(state);
					}).catch((err: any) => cleanup(err, false));
				};
				const triggered = () => {
					if (entry.settled || entry.defer != null)
						return;

					/* check if the signal should be deferred */
					const timeSinceLast = Date.now() - entry.lastUpdate;
					if (timeSinceLast < WATCHER_COALESCE_PERIOD_MS)
						entry.defer = setTimeout(() => changed(true), WATCHER_COALESCE_PERIOD_MS - timeSinceLast);
					else
						changed(true);
				};

				/* trigger a silent change event, to ensure the child waters are configured */
				changed(false);
			}
			catch (err: any) {
				/* in case of the path not being found, pretend it has been removed */
				this.error(`Failed watching path [${filePath}]: ${err.message}`);
				client.send(err.code == 'ENOENT' ? 'removed' : 'error');
				client.close();
				return;
			}
		}

		/* add the web-socket to the listener and check if the closing timeout needs to be stopped */
		client.log(`Subscribe to changes of [${path}]`);
		const entry = this.listener[path];
		entry.ws.add(client);
		if (entry.grace != null)
			clearTimeout(entry.grace);
		entry.grace = null;

		/* no need to listen for data, as this is only a notification channel */
		client.on('close', () => {
			entry.ws.delete(client);
			client.log(`Unsubscribe from changes of [${path}]`);

			/* check if this was the last listener, and the watcher should be closed */
			if (entry.ws.size == 0 && !entry.settled)
				entry.grace = setTimeout(() => entry.close('unused'), WATCHER_GRACE_MS);
		});
	}
	protected override async handleRequest(client: mws.ClientRequest, raw?: mws.Params): Promise<void> {
		const params: BurntParams = {
			access: (typeof raw?.access == 'boolean' ? raw : this.defaultParams).access,
			upload: (typeof raw?.upload == 'boolean' ? raw : this.defaultParams).upload,
			delete: (typeof raw?.delete == 'boolean' ? raw : this.defaultParams).delete,
			uploadMTime: (typeof raw?.uploadMTime == 'boolean' ? raw : this.defaultParams).uploadMTime,
			uploadLimit: (typeof raw?.uploadLimit == 'number' && isFinite(raw.uploadLimit) ? raw : this.defaultParams).uploadLimit,
			rebase: (typeof raw?.rebase == 'string' ? mws.sanitize(raw.rebase, false) : this.defaultParams.rebase)
		};
		client.trace(`Files handler for [${client.path}] (A: ${params.access} | U: ${params.upload} | D: ${params.delete} | T: ${params.uploadMTime} | L: ${params.uploadLimit})`);

		/* check if its a request for the files API (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.files)) {
			if (!params.access)
				return client.respondForbidden({ reason: 'Not allowed to access content' });
			const path = this.decodePath(client, client.getChildPath(Endpoints.files));
			if (path == null)
				return;
			return this.handleFiles(client, path, params);
		}

		/* check if its one of the listener (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.sockets)) {
			if (!params.access)
				return client.respondForbidden({ reason: 'Not allowed to access content' });
			const path = this.decodePath(client, client.getChildPath(Endpoints.sockets));
			if (path == null)
				return;

			/* try to accept the web socket and handle it (await acceptance to ensure the
			*	stop method is not entered before the full accept has been performed) */
			const ws = await client.acceptWebSocket();
			if (ws != null)
				this.acceptWebSocket(ws, mws.joinSanitized(params.rebase, path));
			return;
		}

		/* check if its just static content to be served */
		if (client.isInsideOf(Endpoints.static) && client.requireMethod('GET') != null)
			await client.tryRespondFile(this.fileStatic(client.getChildPath(Endpoints.static)));

		/* check if its a request for a job and respond with its status */
		if (client.isInsideOf(Endpoints.jobs) && client.requireMethod('GET') != null) {
			if (!params.access)
				return client.respondForbidden({ reason: 'Not allowed to access content' });

			const id = client.getChildPath(Endpoints.jobs).substring(1);
			if (!(id in this.copyJobs.entries))
				return client.respondNotFound();
			const job = this.copyJobs.entries[id];
			return client.respondJson({ progress: job.progress, state: job.state, message: job.message });
		}
	}
	protected override async handleStop(): Promise<void> {
		/* close all sockets and listener (no new sockets can arrive anymore once the stop-handler has started) */
		const promises: Promise<void>[] = [];
		for (const path in this.listener)
			promises.push(this.listener[path].close('close'));

		/* abort any active jobs */
		for (const id in this.copyJobs.entries)
			promises.push(this.copyJobs.entries[id].abort());
		await Promise.all(promises);

		/* clear any potential cleanup timers */
		if (this.reservations.timeout != null)
			clearTimeout(this.reservations.timeout);
		if (this.copyJobs.timeout != null)
			clearTimeout(this.copyJobs.timeout);
	}
}

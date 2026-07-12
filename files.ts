/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libCrypto from "crypto";
import * as libFs from "fs";
import * as libFsPromises from "fs/promises";
import * as libStream from "stream";
import * as libZlib from "zlib";

const MAX_UPLOAD_SIZE = 10_000_000_000;
const MAX_RESERVATION_TIME_MS = 2_000;
const WATCHER_GRACE_MS = 30 * 1000;
const VALID_NAME_REGEX = /^[^\x00-\x1f\x7f/\\\?:\*"<>\|]+$/;

type FileKind = 'file' | 'directory';
interface DirEntry {
	kind: FileKind;
	size: number;
	modified: number;
}
interface DirListener {
	ws: Set<mws.ClientSocket>;
	timeout: NodeJS.Timeout | null;
	close: () => void;
	settled: boolean;
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
 *	Endpoints used by the module.
 *	This mapping can be used to translate components of the module to different paths in the URL space.
 *
 *	All paths in the url use URI encoding for the components, while preserving '/'.
 *	All paths in json format are not encoded.
 */
export const Endpoints = {
	/** directory containting static assets (sparsely used) */
	static: '/static',

	/** directory for raw files and directory listings and views (GET, DELETE, POST) */
	files: '/files',

	/** directory for web-sockets for change listener */
	sockets: '/ws'
}

export class FileShare extends mws.ModuleHandler {
	private fileStorage: (path: string) => string;
	private fileStatic: (path: string) => string;
	private fileAssets: (path: string) => string;
	private listener: Record<string, DirListener>;
	private reservations: {
		timeout: NodeJS.Timeout | null;
		entries: Record<string, { age: number, id: string }>;
	};

	/** [dataPath] is the path to all of the directories and files to be served (must be the path to a directory) */
	constructor(dataPath: string) {
		super('files');

		this.fileStorage = mws.createPathLocation(dataPath);
		this.fileStatic = mws.createPathSelf(import.meta.url, '../static');
		this.fileAssets = mws.createPathSelf(import.meta.url, '../assets');
		this.listener = {};
		this.reservations = { timeout: null, entries: {} };
	}

	private checkReservations(): void {
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
			this.reservations.timeout = setTimeout(() => this.checkReservations(), MAX_RESERVATION_TIME_MS);
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
	private async tryReservePath(client: mws.ClientRequest, filePath: string, parent: string, reservation: string): Promise<string | null> {
		/* check if the path is already reserved */
		if (!this.checkOrUseReservation(client, filePath, reservation))
			return null;

		/* already insert the new reservation (to ensure no race condition while applying) */
		const id = libCrypto.randomUUID();
		this.reservations.entries[filePath] = { id, age: Date.now() };
		if (this.reservations.timeout == null)
			this.reservations.timeout = setTimeout(() => this.checkReservations(), MAX_RESERVATION_TIME_MS);

		try {
			/* check if the path already exists */
			const stat = await libFsPromises.stat(filePath);
			if (!stat.isDirectory() && !stat.isFile())
				this.warning(`Unsupported file-system object encountered: ${filePath}`);
			client.respondConflict({ message: `Path already exists` });
			delete this.reservations.entries[filePath];
			return null;
		}
		catch (err: any) {
			if (err.code != 'ENOENT') {
				client.respondInternalError(`Failed to reserve [${filePath}]: ${err.message}`);
				delete this.reservations.entries[filePath];
				return null;
			}

			/* check if the parent directory exists */
			let parentExists = false;
			try { parentExists = (await libFsPromises.stat(this.fileStorage(parent))).isDirectory(); } catch (_) { }
			if (!parentExists) {
				client.respondBadRequest({ message: 'Parent does not exist' });
				delete this.reservations.entries[filePath];
				return null;
			}
			return id;
		}
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

		return out;
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
	private async handleUpload(client: mws.ClientRequest, filePath: string, kind: FileKind, parent: string): Promise<void> {
		const reservation = client.url.searchParams.get('reservation') ?? '';

		try {
			/* check if the path is to be reserved or is already reserved (all bad paths are already responded) */
			if (client.url.searchParams.get('reserve') == 'true') {
				const id = await this.tryReservePath(client, filePath, parent, reservation);
				if (id != null)
					client.respondOk({ message: 'Reservation registered', headers: { 'Reservation-Id': id } });
				return;
			}
			if (!this.checkOrUseReservation(client, filePath, reservation))
				return;

			/* check if a directory is to be created */
			if (kind == 'directory') {
				await libFsPromises.mkdir(filePath, { recursive: false });
				return client.respondOk({ message: `Directory created` });
			}

			/* try to upload the file */
			if (!await this.cache.write(filePath, client.receiveData(MAX_UPLOAD_SIZE), { create: true }))
				return client.respondConflict({ message: `Path already exists` });
			return client.respondOk({ message: `File uploaded` });
		}
		catch (err: any) {
			if (err.code == 'ENOENT')
				return client.respondNotFound();
			if (err.code != 'EEXIST')
				return client.respondInternalError(`Failed to create ${kind} [${filePath}]: ${err.message}`);

			/* check if the directory already existed and should fail silently */
			if (kind == 'directory' && client.url.searchParams.get('silent') == 'true') {
				try {
					if ((await libFsPromises.stat(filePath)).isDirectory())
						return client.respondOk({ message: `Already exists` });
				} catch (_) { }
			}
			return client.respondConflict({ message: `Path already exists` });
		}
	}
	private async handleCopyMove(client: mws.ClientRequest, filePath: string, kind: FileKind): Promise<void> {
		const move = client.url.searchParams.get('move') ?? null;
		if (move == null)
			return client.respondBadRequest({ message: 'PUT requires operation target' });

		/* validate the target path (query parameters are received decoded, hence only sanitize the path and validate its components) */
		const target = mws.sanitize(move, false);
		if (target == '/')
			return client.respondBadRequest({ message: 'Root cannot be a move target' });
		for (const name of target.substring(1).split('/')) {
			if (!name.match(VALID_NAME_REGEX))
				return client.respondBadRequest({ message: `Invalid path component [${name}]` });
		}
		const fileTarget = this.fileStorage(target);

		/* validate the source kind */
		try {
			if (!await this.checkPathKind(client, filePath, kind))
				return;
		} catch (err: any) {
			if (err.code == 'ENOENT')
				return client.respondNotFound();
			return client.respondInternalError(`Failed to move [${filePath}]: ${err.message}`);
		}

		/* validate and reserve the destination (ensures parent exists and name cannot be used again) */
		const reservation = client.url.searchParams.get('reservation') ?? '';
		const id = await this.tryReservePath(client, fileTarget, mws.splitFileName(target)[0], reservation);
		if (id == null)
			return;

		/* perform the actual move (ignore any race conditions, if the path is modified up to the move) and clear the reservation */
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
		if (this.reservations.entries[fileTarget]?.id == id)
			delete this.reservations.entries[fileTarget];
	}
	private async handleDelete(client: mws.ClientRequest, filePath: string, kind: FileKind): Promise<void> {
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
	private async handleDownload(client: mws.ClientRequest, name: string, filePath: string, list: Record<string, DirEntry>): Promise<void> {
		client.log(`Zipping directory [${filePath}]`);

		/* prepare writing the directory content to a zip file and create the zipper (automatically handles errors and
		*	closes connection) or immediately respond, if its only a head request and no content needs to be produced */
		const writer = client.respondData({ media: mws.Media.Zip, headers: { 'Kind': 'directory', 'Content-Disposition': `attachment; filename="${name}.zip"` } });
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
	private async handleFiles(client: mws.ClientRequest, path: string): Promise<void> {
		const filePath = this.fileStorage(path);

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'PUT', 'DELETE']);
		if (method == null)
			return;

		/* check if the method is allowed for the given endpoint */
		if (path == '/' && method != 'GET')
			return client.respondForbidden({ message: 'Root cannot be modified' });

		/* validate the request kind */
		const kind = client.url.searchParams.get('kind');
		if (kind != null && kind != 'file' && kind != 'directory')
			return client.respondBadRequest({ message: `Unsupported kind [${kind}] encountered` });

		/* check if the entry is to be deleted or uploaded or moved */
		if (method == 'POST')
			return this.handleUpload(client, filePath, (kind ?? 'file'), mws.splitFileName(path)[0]);
		if (method == 'PUT')
			return this.handleCopyMove(client, filePath, (kind ?? 'file'));
		if (method == 'DELETE')
			return this.handleDelete(client, filePath, (kind ?? 'file'));

		/* try to serve it as a file (root cannot be served as a file) */
		if ((kind == null || kind == 'file') && path != '/') {
			const headers: Record<string, string> = { 'Kind': 'file' };

			/* check if its supposed to be a download */
			if (client.url.searchParams.get('download') == 'true')
				headers['Content-Disposition'] = `attachment; filename="${mws.splitFileName(path)[1]}"`;

			/* try to perform the actual serving (check freshness at all times, as the file might be changed) */
			if (await client.tryRespondFile(filePath, { checkFreshness: true, headers }))
				return;
		}

		/* try to serve it as a directory */
		if (kind == null || kind == 'directory') {
			try {
				/* try to read the directory state */
				const list = await this.fetchDirectoryList(filePath);

				/* check if the directory should be served in raw */
				if (client.url.searchParams.get('raw') == 'true')
					return client.respond(JSON.stringify(list), { media: mws.Media.Json, status: mws.Status.Ok, headers: { 'Kind': 'directory' } });

				/* check if the directory is to be downloaded and otherwise create the directory view */
				if (client.url.searchParams.get('download') == 'true') {
					const [_, name] = mws.splitFileName(path);
					return this.handleDownload(client, (name == '' ? 'directory' : name), filePath, list);
				}
				return this.buildView(client, path, list);
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
		return client.makePath(this.cache.immutable(this.name, mws.joinSanitized(Endpoints.static, path)));
	}
	private async buildView(client: mws.ClientRequest, path: string, list: Record<string, DirEntry>): Promise<void> {
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
			delete: true,
			upload: true,
			maxUploadSize: MAX_UPLOAD_SIZE,
			path,
			root: client.makePath(Endpoints.files),
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

		/* add the required page headers and load the content from cache (prevent
		*	user-zooming as this breaks viewport handling for keyboard-detection) */
		const b = mws.build;
		const page = new b.HtmlPage({
			language: 'en',
			head: [
				b.Meta('viewport', 'width=device-width, initial-scale=1'),
				b.Title(`Directory: ${title}`),
				b.Meta('Description', `Content of directory ${path}`),
				b.LoadStyle(this.staticPath(client, '/style.css')),
				b.LoadScript(this.staticPath(client, '/main.js')),
				b.AddScript(`__LOAD_PARAMS__=${loadParams}`)
			],
			body: b.Embed(body, true)
		});
		client.respondHtml(page, { status: mws.Status.Ok });
	}
	private acceptWebSocket(client: mws.ClientSocket, path: string): void {
		/* check if the listener needs to be created */
		if (!(path in this.listener)) {
			const filePath = this.fileStorage(path);
			try {
				/* ensure that the watched path is a directory */
				const stats = libFs.statSync(filePath);
				if (!stats.isDirectory())
					throw new Error(`Can only watch directories`);
				this.info(`Started listening for changes: [${filePath}]`);
				const watcher = libFs.watch(filePath);

				const entry: DirListener = {
					timeout: null,
					ws: new Set<mws.ClientSocket>(),
					close: () => {
						watcher.close();
						this.info(`Stopped listening for changes: [${filePath}]`);
					},
					settled: false
				};
				const cleanup = (err: any, removed: boolean) => {
					this.error(`Error while watching path [${filePath}]: ${err.message}`);

					/* remove the entry and notify all listener */
					delete this.listener[path];
					entry.close();
					entry.settled = true;
					for (const ws of entry.ws) {
						ws.send(removed ? 'removed' : 'error');
						ws.close();
					}
				};
				this.listener[path] = entry;

				/* register the watcher listener */
				watcher.on('change', () => {
					/* ensure that the directory still exists */
					try {
						const stats = libFs.statSync(filePath);
						if (!stats.isDirectory())
							throw new Error(`Can only watch directories`);
						for (const ws of entry.ws)
							ws.send('change');
					}
					catch (err: any) {
						cleanup(err, (err.code == 'ENOENT'));
					}

				});
				watcher.on('error', (err: any) => cleanup(err, false));
			}
			catch (err: any) {
				this.error(`Failed watching path [${filePath}]: ${err.message}`);
				client.send('error');
				client.close();
				return;
			}
		}

		/* add the web-socket to the listener and check if the closing timeout needs to be stopped */
		const entry = this.listener[path];
		entry.ws.add(client);
		if (entry.timeout != null)
			clearTimeout(entry.timeout);
		entry.timeout = null;

		/* no need to listen for data, as this is only a notification channel */
		client.on('close', () => {
			entry.ws.delete(client);

			/* check if this was the last listener, and the watcher should be closed */
			if (entry.ws.size != 0 || entry.settled)
				return;
			entry.timeout = setTimeout(() => {
				delete this.listener[path];
				entry.close();
			}, WATCHER_GRACE_MS);
		});
	}
	protected override async handleRequest(client: mws.ClientRequest): Promise<void> {
		client.trace(`Files handler for [${client.path}]`);

		/* check if its one of the listener (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.sockets)) {
			const path = this.decodePath(client, client.getChildPath(Endpoints.sockets));
			if (path == null)
				return;

			/* try to accept the web socket and handle it (await acceptance to ensure the
			*	stop method is not entered before the full accept has been performed) */
			const ws = await client.acceptWebSocket();
			if (ws != null)
				this.acceptWebSocket(ws, path);
			return;
		}

		/* check if its a request for the files API (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.files)) {
			const path = this.decodePath(client, client.getChildPath(Endpoints.files));
			if (path == null)
				return;
			return this.handleFiles(client, path);
		}

		/* check if its just static content to be served */
		if (client.isInsideOf(Endpoints.static) && client.requireMethod('GET') != null)
			await client.tryRespondFile(this.fileStatic(client.getChildPath(Endpoints.static)));
	}
	protected override async handleStop(): Promise<void> {
		/* close all sockets (no new sockets can arrive anymore once the stop-handler has started) */
		const promises: Promise<void>[] = [];
		for (const path in this.listener) {
			const entry = this.listener[path];
			entry.settled = true;

			for (const ws of entry.ws) {
				ws.send('close');
				promises.push(ws.close());
			}
		}
		await Promise.all(promises);

		/* reset all timers (after the closes have been processed, as they may otherwise re-start the last timer) */
		for (const path in this.listener) {
			const entry = this.listener[path];

			if (entry.timeout != null)
				clearTimeout(entry.timeout);
			entry.close();
		}

		/* reset any potential reservation-clear timers */
		if (this.reservations.timeout != null)
			clearTimeout(this.reservations.timeout);
		this.reservations = { timeout: null, entries: {} };
	}
}

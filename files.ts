/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libCrypto from "crypto";
import * as libFs from "fs";
import * as libFsPromises from "fs/promises";
import * as libStream from "stream";

const MAX_UPLOAD_SIZE = 10_000_000_000;
const MAX_RESERVATION_TIME_MS = 2_000;
const WATCHER_GRACE_MS = 30 * 1000;

interface DirEntry {
	kind: string;
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
	private cleanup: (err: any) => void;
	private sink: libStream.Writable;

	public constructor(sink: libStream.Writable) {
		this.cleanup = () => { };
		this.sink = sink;
		this.sink.once('error', (err: any) => this.cleanup(err));
	}
	private localFileHeader(modified: number, path: string, deflate: boolean): Buffer {
		/* encode the path (without the leading slash) and check if it fits into the header */
		const encoded = Buffer.from(path.substring(1), 'utf-8');
		if (encoded.length > 65535) {
			this.sink.destroy(new Error(`Path [${path}] cannot be encoded`));
			return Buffer.alloc(0);
		}
		const out = Buffer.alloc(30 + encoded.length);
		let offset = 0;

		/* signature, version (6.3.0 => 630), generalPurposeFlag (bit3 for tailing data-descriptor; bit11 for utf-8), compression (0 = none; 8 = deflate) */
		offset = out.writeUInt32LE(0x04034b50, offset);
		offset = out.writeUInt16LE(630, offset);
		offset = out.writeUInt16LE((0x01 << 3) | (0x01 << 11), offset);
		offset = out.writeUInt16LE((deflate ? 0x08 : 0x00), offset);

		/* last-modification time; last-modification date */
		const date = new Date(modified);
		offset = out.writeUInt16LE((date.getSeconds() / 2) | (date.getMinutes() << 5) | (date.getHours() << 11), offset);
		offset = out.writeUInt16LE(date.getDate() | ((date.getMonth() + 1) << 5) | ((date.getFullYear() - 1980) << 9), offset);

		/* crc32, compressed-size, uncompressed-size (all defaulted for data-descriptor mode) */
		offset = out.writeUint32LE(0x00, offset);
		offset = out.writeUint32LE(0xffffffff, offset);
		offset = out.writeUint32LE(0xffffffff, offset);

		/* write the file name length and extra field length out */
		offset = out.writeUint16LE(encoded.length, offset);
		offset = out.writeUint16LE(0, offset);

		/* write the actual name out */
		encoded.copy(out, offset);
		return out;
	}

	public write(path: string, modified: number, data: libStream.Readable): Promise<void> {
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

			/* write the local header out (ignore any errors, as they will propagate out through the error listener as well) */
			await new Promise<void>((res) => this.sink.write(this.localFileHeader(modified, path, false), () => res));
			if (settled || this.sink.destroyed) return;

			/* pipe the data from the file through the transformer (to compute crc and sum up the size) */
			let totalSize = 0;
			const transform = new libStream.Transform({
				transform: (chunk, _, cb) => {
					if (settled) return cb(new Error('Writing already completed'));
					totalSize += chunk.byteLength;
					cb(null, chunk);
				},
				final: (cb) => {
					if (settled) return cb(new Error('Writing already completed'));
					if (totalLength == this.size)
						this.cache.add(this.path, Buffer.concat(buffers), this.mtime, this.age);
					cb(null);
				}
			});
		});
	}
	public async close(): Promise<void> {

	}
}

/**
 *	Endpoints used by the module.
 *	This mapping can be used to translate components of the module to different paths in the URL space.
 */
export const Endpoints = {
	/** directory containting static assets (sparsely used) */
	static: '/static',

	/** directory for raw files and directory listings and views (GET, DELETE, POST; fully owned, auto-responds with 404) */
	files: '/files',

	/** directory for web-sockets for change listener (fully owned, auto-responds with 404) */
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
	private async handleUpload(client: mws.ClientRequest, filePath: string, kind: string, parent: string): Promise<void> {
		const reservation = client.url.searchParams.get('reservation') ?? '';

		try {
			/* check if the path has been reserved and this is the user of the reservation */
			if (filePath in this.reservations.entries) {
				if (Date.now() - this.reservations.entries[filePath].age <= MAX_RESERVATION_TIME_MS && this.reservations.entries[filePath].id != reservation)
					return client.respondConflict({ message: `Path has been reserved` });
				delete this.reservations.entries[filePath];
			}

			/* check if a new reservation should be placed, in which case the path needs to be fetched in order to determine if it already exists */
			if (client.url.searchParams.get('reserve') == 'true') {
				const stat = await libFsPromises.stat(filePath);
				if (!stat.isDirectory() && !stat.isFile())
					this.warning(`Unsupported file-system object encountered: ${filePath}`);
				return client.respondConflict({ message: `Path already exists` });
			}

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
			/* check if the path does not yet exist, but is being reserved */
			if (err.code == 'ENOENT') {
				if (client.url.searchParams.get('reserve') != 'true')
					return client.respondNotFound();

				/* check if the parent directory exists */
				let parentExists = false;
				try { parentExists = (await libFsPromises.stat(this.fileStorage(parent))).isDirectory(); }
				catch (err: any) { }
				if (!parentExists)
					return client.respondNotFound();

				/* insert the new reservation */
				const id = libCrypto.randomUUID();
				this.reservations.entries[filePath] = { id, age: Date.now() };
				if (this.reservations.timeout == null)
					this.reservations.timeout = setTimeout(() => this.checkReservations(), MAX_RESERVATION_TIME_MS);
				return client.respondOk({ message: 'Reservation registered', headers: { 'Reservation-Id': id } });
			}
			if (err.code != 'EEXIST')
				return client.respondInternalError(`Failed to create/reserve ${kind} [${filePath}]: ${err.message}`);

			/* check if the directory already existed and should fail silently */
			if (kind == 'directory' && client.url.searchParams.get('silent') == 'true') {
				try {
					if ((await libFsPromises.stat(filePath)).isDirectory())
						return client.respondOk({ message: `Already exists` });
				}
				catch (err: any) { }
			}
			return client.respondConflict({ message: `Path already exists` });
		}
	}
	private async handleDelete(client: mws.ClientRequest, filePath: string, kind: string): Promise<void> {
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
				const stats = await libFsPromises.stat(filePath);
				if (!stats.isFile() && !stats.isDirectory())
					this.warning(`Unsupported file-system object encountered: ${filePath}`);
				if (!(kind == 'directory' ? stats.isDirectory() : stats.isFile()))
					return client.respondConflict({ message: `Path is not a ${kind}` });
			}
			catch (_err: any) {
				if (_err.code == 'ENOENT')
					return client.respondNotFound();
			}
			client.respondInternalError(`Failed to remove file [${filePath}]: ${err.message}`);
		}
	}
	private async handleDownload(client: mws.ClientRequest, name: string, list: Record<string, DirEntry>): Promise<void> {
		return client.respondInternalError('Not yet implemented');

		/* prepare writing the directory content to a zip file */
		const writer = client.respondData({ headers: { 'Kind': 'directory', 'Content-Disposition': `attachment; filename="${name}.zip"` } });

		/* create the zip wrapper and write the data */

	}
	private async handleFiles(client: mws.ClientRequest): Promise<void> {
		const relativePath = client.getChildPath(Endpoints.files);
		const filePath = this.fileStorage(relativePath);

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'DELETE']);
		if (method == null)
			return;

		/* check if the method is allowed for the given endpoint */
		if (relativePath == '/' && method != 'GET')
			return client.respondForbidden({ message: 'Root cannot be modified' });

		/* validate the request kind */
		const kind = client.url.searchParams.get('kind');
		if (kind != null && kind != 'file' && kind != 'directory')
			return client.respondBadRequest({ message: `Unsupported kind [${kind}] encountered` });

		/* check if the entry is to be deleted or uploaded */
		if (method == 'POST')
			return this.handleUpload(client, filePath, (kind ?? 'file'), mws.splitFilePath(relativePath)[0]);
		if (method == 'DELETE')
			return this.handleDelete(client, filePath, (kind ?? 'file'));

		/* try to serve it as a file (root cannot be served as a file) */
		if (kind == null || kind == 'file') {
			if (relativePath != '/') {
				const headers: Record<string, string> = { 'Kind': 'file' };

				/* check if its supposed to be a download */
				if (client.url.searchParams.get('download') == 'true') {
					const [_, name, ext] = mws.splitFilePath(relativePath);
					headers['Content-Disposition'] = `attachment; filename="${name}${ext}"`;
				}

				/* try to perform the actual serving (check freshness at all times, as the file might be changed) */
				if (await client.tryRespondFile(filePath, { checkFreshness: true, headers }))
					return;
			}

			/* check if a file-kind was expected */
			if (kind == 'file')
				return client.respondConflict({ message: `Path is not a file` });
		}

		/* try to read the directory state */
		let list: Record<string, DirEntry> = {};
		try { list = await this.fetchDirectoryList(filePath); } catch (err: any) {
			if (err.code == 'ENOENT')
				return client.respondNotFound();
			if (err.code != 'ENOTDIR')
				return client.respondInternalError(`Failed to serve path [${filePath}]: ${err.message}`);

			/* check if its an unsupported kind or if it was a file (if nothing was requested, must have been a race condition, just ignore) */
			try {
				const stats = await libFsPromises.stat(filePath);
				if (kind == 'directory' && stats.isFile())
					return client.respondConflict({ message: `Path is not a directory` });
				if (!stats.isFile() && !stats.isDirectory())
					this.warning(`Unsupported file-system object encountered: ${filePath}`);
			} catch (_) { }
			return client.respondNotFound();
		}

		/* check if the directory should be served in raw */
		if (client.url.searchParams.get('raw') == 'true')
			return client.respond(JSON.stringify(list), { media: mws.Media.Json, status: mws.Status.Ok, headers: { 'Kind': 'directory' } });

		/* check if the directory is to be downloaded */
		if (client.url.searchParams.get('download') == 'true') {
			const [_, name, ext] = mws.splitFilePath(relativePath);
			return this.handleDownload(client, (name == '' && ext == '' ? 'directory' : `${name}${ext}`), list);
		}

		/* build the view for the directory */
		return this.buildView(client, relativePath, list);
	}
	private async fetchBody(client: mws.ClientRequest, path: string): Promise<string | null> {
		const fullPath = this.fileAssets(path);

		/* look for the file */
		try {
			const data: Buffer | null = await this.cache.read(fullPath);
			if (data == null) {
				client.respondInternalError(`Failed to find content [${fullPath}]`);
				return null;
			}
			return data.toString('utf-8');
		}
		catch (err: any) {
			client.respondInternalError(`Failed to read content [${fullPath}]: ${err.message}`);
			return null;
		}
	}
	private staticPath(client: mws.ClientRequest, path: string): string {
		return client.makePath(this.cache.immutable(this.name, mws.joinSanitized(Endpoints.static, path)));
	}
	private async buildView(client: mws.ClientRequest, path: string, list: Record<string, DirEntry>): Promise<void> {
		/* read the body */
		const body: string | null = await this.fetchBody(client, '/page.html');
		if (body == null)
			return;

		const loadParams: string = JSON.stringify({
			delete: true,
			upload: true,
			maxUploadSize: MAX_UPLOAD_SIZE,
			basePath: path,
			rootPath: client.makePath(Endpoints.files),
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
		const title = mws.splitFilePath(path).slice(1).join('');

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
		await client.respondHtml(page, { status: mws.Status.Ok });
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

		/* check if its just static content to be served */
		if (client.isInsideOf(Endpoints.static)) {
			if (client.requireMethod('GET') != null)
				await client.tryRespondFile(this.fileStatic(client.getChildPath(Endpoints.static)));
			return;
		}

		/* check if its one of the listener (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.sockets)) {
			const relativePath = client.getChildPath(Endpoints.sockets);

			/* try to accept the web socket and handle it (await acceptance to ensure the
			*	stop method is not entered before the full accept has been performed) */
			const ws = await client.acceptWebSocket();
			if (ws != null)
				this.acceptWebSocket(ws, relativePath);
			return;
		}

		/* check if its a request for the files API (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.files))
			return this.handleFiles(client);
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

/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libFsPromises from "fs/promises";

const MAX_UPLOAD_SIZE = 100_000_000;

interface DirEntry {
	kind: string;
	size: number;
	modified: number;
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

	/** directory for web-sockets */
	__sockets: '/ws'
}

export class FileShare extends mws.ModuleHandler {
	private fileStorage: (path: string) => string;
	private fileStatic: (path: string) => string;
	private fileAssets: (path: string) => string;

	constructor(dataPath: string) {
		super('files');

		this.fileStorage = mws.createPathLocation(dataPath);
		this.fileStatic = mws.createPathSelf(import.meta.url, '../static');
		this.fileAssets = mws.createPathSelf(import.meta.url, '../assets');
	}

	private async fetchDirectoryList(filePath: string): Promise<Record<string, DirEntry>> {
		const out: Record<string, DirEntry> = {};

		/* let errors propagate outward */
		const content = await libFsPromises.readdir(filePath);

		/* collect all of the meta data about the directory (silently ignore errors) */
		for (const name of content) {
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
	private async handleUpload(client: mws.ClientRequest, filePath: string): Promise<void> {
		const kind = client.url.searchParams.get('kind') ?? 'file';
		if (kind != 'file' && kind != 'directory')
			return client.respondBadRequest(`Unsupported kind [${kind}] encountered`);

		try {
			/* check if a directory is to be created */
			if (kind == 'directory') {
				await libFsPromises.mkdir(filePath, { recursive: false });
				return client.respondOk({ message: `Directory created` });
			}

			/* try to upload the file */
			else if (!await this.cache.write(filePath, client.receiveData(MAX_UPLOAD_SIZE), { create: true }))
				return client.respondConflict(`Path already exists`);
			return client.respondOk({ message: `File uploaded` });
		}
		catch (err: any) {
			if (err.code == 'ENOENT')
				return client.respondBadRequest(`Path for ${kind} does not exist`);
			if (err.code == 'EEXIST')
				return client.respondConflict(`Path already exists`);
			return client.respondInternalError(`Failed to create ${kind} [${filePath}]: ${err}`);
		}
	}
	private async handleDelete(client: mws.ClientRequest, filePath: string): Promise<void> {
		const kind = client.url.searchParams.get('kind') ?? 'file';
		if (kind != 'file' && kind != 'directory')
			return client.respondBadRequest(`Unsupported kind [${kind}] encountered`);

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
				return client.respondConflict('Directory not empty');

			/* check if its a kind mis-match */
			try {
				const stats = await libFsPromises.stat(filePath);
				if (!stats.isFile() && !stats.isDirectory())
					this.warning(`Unsupported file-system object encountered: ${filePath}`);
				if (!(kind == 'directory' ? stats.isDirectory() : stats.isFile()))
					return client.respondConflict(`Path is not a ${kind}`);
			}
			catch (_err: any) {
				if (_err.code == 'ENOENT')
					return client.respondNotFound();
			}
			client.respondInternalError(`Failed to remove file [${filePath}]: ${err.message}`);
		}
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
			icons: {
				back: this.staticPath(client, '/back-icon.svg'),
				close: this.staticPath(client, '/close-icon.svg'),
				create: this.staticPath(client, '/create-icon.svg'),
				delete: this.staticPath(client, '/delete-icon.svg'),
				download: this.staticPath(client, '/download-icon.svg'),
				home: this.staticPath(client, '/home-icon.svg')
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
				b.Meta('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no'),
				b.Title(`Directory ${title}`),
				b.Meta('Description', `Content of directory ${path}`),
				b.LoadStyle(this.staticPath(client, '/style.css')),
				b.LoadScript(this.staticPath(client, '/main.js')),
				b.AddScript(`__LOAD_PARAMS__=${loadParams}`)
			],
			body: b.Embed(body, true)
		});
		await client.respondHtml(page, { status: mws.Status.Ok });
	}
	protected override async handleRequest(client: mws.ClientRequest): Promise<void> {
		client.trace(`Files handler for [${client.path}]`);

		/* check if its just static content to be served */
		if (client.isInsideOf(Endpoints.static) && client.requireMethod('GET') != null)
			await client.tryRespondFile(this.fileStatic(client.getChildPath(Endpoints.static)));

		/* check if its a request for the files API (allow root itself for reading it) */
		else if (!client.isSubPathOf(Endpoints.files))
			return;
		const relativePath = client.getChildPath(Endpoints.files);
		const filePath = this.fileStorage(relativePath);

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'DELETE']);
		if (method == null)
			return;

		/* check if the method is allowed for the given endpoint */
		if (relativePath == '/' && method != 'GET')
			return client.respondForbidden('Root cannot be modified', { forwardReason: true });

		/* check if the entry is to be deleted or uploaded */
		if (method == 'DELETE')
			return this.handleDelete(client, filePath);
		else if (method == 'POST')
			return this.handleUpload(client, filePath);

		try {
			const stats = await libFsPromises.stat(filePath);

			/* check if a file is to be served */
			if (stats.isFile()) {
				if (!await client.tryRespondFile(filePath, { checkFreshness: true, headers: { 'File-Kind': 'file' } }))
					client.respondNotFound();
				return;
			}

			/* check if its an unknown type */
			if (!stats.isDirectory()) {
				this.warning(`Unsupported file-system object encountered: ${filePath}`);
				return client.respondNotFound();
			}
			const list = await this.fetchDirectoryList(filePath);

			/* check if the directory should be served in raw */
			if (client.url.searchParams.get('raw') == 'true')
				return client.respond(JSON.stringify(list), { media: mws.Media.Json, status: mws.Status.Ok, headers: { 'File-Kind': 'directory' } });

			/* build the view for the directory */
			await this.buildView(client, relativePath, list);
		} catch (err: any) {
			if (err.code != 'ENOENT')
				return client.respondInternalError(`Failed to serve path [${filePath}]: ${err.message}`);
			client.respondNotFound();
		}
	}
	protected override async handleStop(): Promise<void> { }
}

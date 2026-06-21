/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libFsPromises from "fs/promises";
import * as libFs from "fs";

const MAX_UPLOAD_SIZE = 100_000_000;

/**
 *	Endpoints used by the module.
 *	This mapping can be used to translate components of the module to different paths in the URL space.
 */
export const Endpoints = {
	/** directory containting static assets (sparsely used) */
	static: '/static',

	/** directory for viewing files */
	lobby: '/view',

	/** directory for raw files (GET, DELETE, POST; fully owned, auto-responds with 404) */
	files: '/raw',

	/** directory for web-sockets */
	sockets: '/ws'
}

export class FileShare extends mws.ModuleHandler {
	private templates: { entry: string, empty: string, page: string };
	private fileStorage: (path: string) => string;
	private fileStatic: (path: string) => string;

	constructor(dataPath: string) {
		super('files');

		this.fileStorage = mws.createPathLocation(dataPath);
		this.fileStatic = mws.createPathSelf(import.meta.url, '../static');
		this.templates = {
			empty: '',
			entry: '',
			page: libFs.readFileSync(this.fileStatic('/page.html'), 'utf-8')
		};
	}

	private async listDirectory(client: mws.ClientRequest, filePath: string): Promise<void> {
		let content: string[];
		try {
			content = await libFsPromises.readdir(filePath);
		}
		catch (err: any) {
			client.respondInternalError(`Filesystem error while reading directory [${filePath}]: ${err.message}`);
			return;
		}

		/* cleanup the path to end in a slash */
		let dirPath = client.url.pathname;
		if (!dirPath.endsWith('/'))
			dirPath = dirPath + '/';

		/* check if the parent directory should be added */
		const hasParent = (client.path != '/');

		/* check if entries have been found */
		let entries = '';
		if (hasParent || content.length > 0) {
			const teEntry = this.templates.entry;

			/* add the parent entry */
			if (hasParent) {
				const parentPath = dirPath.substring(0, dirPath.lastIndexOf('/', dirPath.length - 2));
				entries += mws.expandPlaceholders(teEntry, { path: parentPath, name: '..', type: 'dir' }, true);
			}

			/* expand all entries */
			for (let i = 0; i < content.length; ++i) {
				const childPath = dirPath + content[i];
				let type = 'file';
				try {
					if ((await libFsPromises.stat(this.fileStorage(client.path + '/' + content[i]))).isDirectory())
						type = 'dir';
				} catch (_) { }

				entries += mws.expandPlaceholders(teEntry, { path: childPath, name: content[i], type }, true);
			}
		}
		else
			entries = mws.expandPlaceholders(this.templates.empty, {}, true);

		/* update the path to not contain the trailing slash */
		if (dirPath != '/')
			dirPath = dirPath.substring(0, dirPath.length - 1);

		/* construct the final template and return it */
		const out = mws.expandPlaceholders(this.templates.page, { path: client.path, basepath: '.', entries: entries }, false);
		client.respond(out, { media: mws.Media.Html });
	}

	private async fetchDirectoryState(filePath: string): Promise<string> {
		const out: Record<string, { kind: string, size: number, modified: number }> = {};

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
		return JSON.stringify(out);
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
	private async handleFiles(client: mws.ClientRequest, path: string): Promise<void> {
		const filePath = this.fileStorage(path);

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'DELETE']);
		if (method == null)
			return;

		/* check if the method is allowed for the given endpoint */
		if (path == '/' && method != 'GET')
			return client.respondForbidden('Root cannot be modified', { forwardReason: true });

		/* check if the entry is to be deleted or uploaded */
		if (method == 'DELETE')
			return this.handleDelete(client, filePath);
		else if (method == 'POST')
			return this.handleUpload(client, filePath);

		try {
			const stats = await libFsPromises.stat(filePath);

			/* server the directory or file */
			if (stats.isDirectory())
				return client.respond(await this.fetchDirectoryState(filePath), { media: mws.Media.Json, status: mws.Status.Ok, headers: { 'File-Kind': 'directory' } });
			else if (!stats.isFile())
				this.warning(`Unsupported file-system object encountered: ${filePath}`);
			else if (await client.tryRespondFile(filePath, { checkFreshness: true, headers: { 'File-Kind': 'file' } }))
				return;
		} catch (err: any) {
			if (err.code != 'ENOENT')
				client.respondInternalError(`Failed to serve path [${filePath}]: ${err.message}`);
		}
		client.respondNotFound();
	}
	protected override async handleRequest(client: mws.ClientRequest): Promise<void> {
		client.trace(`Files handler for [${client.path}]`);

		/* check if its a request for the raw files API (allow root itself for reading it) */
		if (client.isSubPathOf(Endpoints.files))
			return this.handleFiles(client, client.getChildPath(Endpoints.files));

		/* expand the path */
		const filePath = this.fileStorage(client.path);

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'DELETE']);
		if (method == null)
			return;

		/* check if the path exists in the filesystem */
		try {
			const stat = await libFsPromises.stat(filePath);

			if (stat.isFile()) {
				await client.tryRespondFile(filePath, { checkFreshness: true });
				return;
			}
			else if (stat.isDirectory())
				return this.listDirectory(client, filePath);
		} catch (err: any) {
			if (err.code != 'ENOENT')
				client.respondInternalError(`Filesystem error while processing [${filePath}]: ${err.message}`);
		}
	}
	protected override async handleStop(): Promise<void> { }
}

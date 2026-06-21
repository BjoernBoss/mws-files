/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2024-2026 Bjoern Boss Henrichsen */
import * as mws from "@bjoernboss/mws";
import * as libFsPromises from "fs/promises";
import * as libFs from "fs";

const maxUploadSize = 100_000_000;

/*	Directory templates
*	page defines:
*		{path}: path of directory
*		{basepath}: base path of the share module
*		{entries}: appended list of children
*	Entry defines:
*		{path}: path to entry
*		{name}: name of entry
*		{type}: 'file' or 'dir'
*	Empty defines:
*		%none%
*/
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

			mws.expandPlaceholders

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
	private async deleteFile(client: mws.ClientRequest, filePath: string): Promise<void> {
		try {
			const stat = await libFsPromises.stat(filePath);
			if (!stat.isFile()) {
				client.respondNotFound();
				return;
			}
			await libFsPromises.unlink(filePath);
			client.respondOk({ message: `File was deleted successfully` });
		} catch (err: any) {
			if (err.code == 'ENOENT') {
				client.respondNotFound();
				return;
			}
			client.respondInternalError(`Filesystem error while deleting [${filePath}]: ${err.message}`);
		}
	}
	private async uploadFile(client: mws.ClientRequest, filePath: string): Promise<void> {
		try {
			await client.receiveToFile(filePath, maxUploadSize);
			client.respondOk({ message: 'File was successfully uploaded' });
		}
		catch (err: any) {
			client.error(`Failed to upload file: ${err.message}`);
		}
	}
	protected override async handleRequest(client: mws.ClientRequest): Promise<void> {
		client.trace(`Shared handler for [${client.path}]`);

		/* expand the path */
		const filePath = this.fileStorage(client.path);

		/* ensure the request is using a supported method */
		const method = client.requireMethod(['GET', 'POST', 'DELETE']);
		if (method == null)
			return;

		/* handle file uploads */
		if (method == 'POST')
			return this.uploadFile(client, filePath);

		/* handle file deletion */
		if (method == 'DELETE')
			return this.deleteFile(client, filePath);

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

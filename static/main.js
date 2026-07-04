/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

const REMOVE_NOTIFICATION_ANIMATION = 35;
const TRANSITION_OVERLAY_ANIMATION = 30;
const FADE_NOTIFICATION_ANIMATION = 3000;
const FILE_MAX_FAILURES = 12;
const FILE_OPERATION_BATCH_SIZE = 4;
const DELAY_UNTIL_SPINNER = 150;
const DROP_ZONE_ANIMATION = 100;
const VALID_NAME_REGEX = /^[^\x00-\x1f\x7f/\\\?:\*"<>\|]+$/;
const UNIT_PREFIX_LIST = [[1_000_000_000_000_000, 'P'], [1_000_000_000_000, 'T'], [1_000_000_000, 'G'], [1_000_000, 'M'], [1_000, 'K'], [1, '']];
const _state = { list: [], fakeEntries: 0, loadedIcons: {}, config: {}, overlay: {}, batchState: { active: 0, waiting: null, resolver: null } };

function buildElement(options) {
	const e = document.createElement(options?.kind ?? 'div');
	if (options?.class != null)
		e.classList = options.class;
	if (options?.text != null)
		e.innerText = options.text;
	else if (options?.child != null)
		e.appendChild(options.child);
	return e;
}
function buildPath(...paths) {
	let out = '/';
	for (const p of paths) {
		if (out.endsWith('/'))
			out += (p.startsWith('/') ? p.substring(1) : p);
		else
			out += (p.startsWith('/') ? p : `/${p}`);
	}
	return out;
}

_state.fs = {
	handleFetchResponse: async (response) => {
		if (response.status == 404)
			return 'Path not found';
		if (response.status == 400 || response.status == 409) {
			let reason = null;
			try { reason = await response.text(); } catch (_) { }
			if (reason != null) return reason;
		}
		return response.statusText;
	},
	fetchDirectory: async (path) => {
		let response = null;

		/* fetch the response from the server */
		try { response = await fetch(`${_state.makePath(true, false, path)}?raw=true&kind=directory`); }
		catch (_) {
			throw 'Network error';
		}

		/* validate the response */
		if (!response.ok)
			throw await _state.fs.handleFetchResponse(response);
		if (response.headers.has('content-type') && !response.headers.get('content-type').startsWith('application/json'))
			throw 'Unexpected server response';

		/* parse the json and return it */
		try {
			const body = await response.json();
			console.log(`Directory [${path}] fetched`);
			return body;
		}
		catch (_) {
			throw 'Malformed server response';
		}
	},
	makeDirectory: async (path, silent) => {
		let response = null;

		/* try to create the new directory */
		try { response = await fetch(`${_state.makePath(true, false, path)}?kind=directory&silence=${silent ? 'true' : 'false'}`, { method: 'POST' }); }
		catch (_) {
			throw 'Network error';
		}

		/* validate the response */
		if (response.ok)
			console.log(`Directory [${path}] created`);
		else
			throw await _state.fs.handleFetchResponse(response);
	},
	remove: async (path, kind) => {
		let response = null;

		/* try to remove the object */
		try { response = await fetch(`${_state.makePath(true, false, path)}?kind=${kind}`, { method: 'DELETE' }); }
		catch (_) {
			throw 'Network error';
		}

		/* validate the response */
		if (response.ok)
			console.log(`${kind == 'directory' ? 'Directory' : 'File'} [${path}] removed`);
		else
			throw await _state.fs.handleFetchResponse(response);
	},
	upload: (path, progress, file) => new Promise(async (resolve, reject) => {
		const baseUrl = `${_state.makePath(true, false, path)}?kind=file`;

		/* try to reserve the given path (to test if its valid/available, before writing data to it) */
		let response = null, settled = false;
		try { response = await fetch(`${baseUrl}&reserve=true`, { method: 'POST' }); }
		catch (_) {
			return reject('Network error');
		}

		/* extract the reservation id */
		if (!response.ok)
			return reject(await _state.fs.handleFetchResponse(response));
		if (!response.headers.has('reservation-id'))
			return reject('Unexpected server response');
		id = response.headers.get('reservation-id');

		/* try to perform the actual upload request using the given reservation */
		const request = new XMLHttpRequest();
		request.open('POST', `${baseUrl}&reservation=${id}`, true);
		request.upload.onprogress = (e) => {
			if (!settled)
				progress(e.loaded / file.size);
		}
		request.onload = () => {
			if (settled) return; settled = true;
			if (request.status < 200 || request.status >= 300)
				return reject('Unexpected server response');
			console.log(`File [${path}] uploaded`);
			resolve();
		};
		request.onerror = () => {
			if (settled) return; settled = true;
			reject('Network error');
		}
		request.send(file);
	})
}
_state.batch = async (task) => {
	const batch = _state.batchState;

	/* wait for space in the queue */
	while (batch.active >= FILE_OPERATION_BATCH_SIZE) {
		if (batch.waiting == null)
			batch.waiting = new Promise((res) => batch.resolver = res);
		await batch.waiting;
	}
	++batch.active;

	/* cleanup helper to clear the queue once it has been emptied */
	const cleanup = () => {
		--batch.active;
		if (batch.waiting == null)
			return;
		batch.waiting = null;
		batch.resolver();
	};

	/* perform the task and preserve the return value/exceptions */
	try {
		const result = await task();
		cleanup();
		return result;
	} catch (e) {
		cleanup();
		throw e;
	}
}
_state.makePath = (root, base, ...paths) => {
	const p0 = (root ? _state.config.rootPath : '/'), p1 = (base ? _state.config.basePath : '/');
	return buildPath(p0, p1, ...paths);
}
_state.formatSize = (size) => {
	for (const option of UNIT_PREFIX_LIST) {
		if (size < option[0] && option[0] > 1)
			continue;
		if (option[1] == '')
			return `${size} Bytes`;
		size /= option[0];
		if (size > 1000)
			return `${Math.round(size)} ${option[1]}B`;
		else
			return `${(size).toPrecision(3)} ${option[1]}B`;
	}
}
_state.loadIcon = (placeholder, name) => {
	/* load the icons manually to ensure they are placed in-place and can be CSS modified */
	const element = buildElement({ class: 'load-icon' });

	let entry = _state.loadedIcons[name] ?? null;

	if (entry != null && entry.content != null) {
		element.innerHTML = entry.content;
		return element;
	}

	/* check if this is the initial request and trigger the fetch */
	if (entry == null) {
		entry = (_state.loadedIcons[name] = {
			content: null,
			resolved: false,
			queue: []
		});

		/* cache the fetches to ensure that failure is logged only once, as every icon
		*	usage (for example via 'src=...') would otherwise trigger the failure log */
		fetch(_state.config.icons[name] ?? '/bad_path').then((resp) => {
			if (!resp.ok)
				throw 0;
			return resp.text();
		}).then((content) => {
			entry.resolved = true;
			entry.content = content;
			for (const elem of entry.queue)
				elem.innerHTML = entry.content;
			entry.queue = [];
		}).catch(() => {
			entry.resolved = true;
			entry.queue = [];
		});
	}

	/* mark the element to be interested in the icon and setup the initial placeholder */
	if (!entry.resolved)
		entry.queue.push(element);
	element.innerHTML = placeholder;
	return element;
}
_state.pushNotification = (body) => {
	const host = document.getElementById('notifications');

	const entry = host.appendChild(buildElement({ class: 'entry' }));

	entry.appendChild(buildElement({ class: 'body', child: body }));
	const close = entry.appendChild(buildElement({ class: 'button', child: _state.loadIcon('Close', 'close') }));

	/* register the animated close handler and the phase-out handler */
	let faded = false, closed = false;
	close.onclick = () => {
		if (closed) return; closed = true;

		/* manually animate, due to unknown initial height */
		entry.animate([
			{ height: `${entry.clientHeight}px`, minHeight: `${entry.clientHeight}px`, easing: 'ease-in' },
			{ height: '0', paddingTop: '0', paddingBottom: '0', minHeight: '0', marginTop: '-0.5em' }
		], { duration: REMOVE_NOTIFICATION_ANIMATION, fill: 'forwards' })
			.onfinish = () => host.removeChild(entry);
	};
	return (fast) => {
		if (fast) {
			close.onclick();
			return;
		}
		if (faded || closed) return; faded = true;

		/* manually animate, in case of immediate fade-out (as first now created, is applied instantly) */
		entry.animate([
			{ opacity: '1', easing: 'ease-in' },
			{ opacity: '0.25' }
		], { duration: FADE_NOTIFICATION_ANIMATION, fill: 'forwards' })
			.onfinish = () => close.onclick();
	};
}
_state.pushTaskStatus = (caption) => {
	const upload = buildElement({ class: 'task' });
	upload.appendChild(buildElement({ class: 'text', text: caption }));
	const info = upload.appendChild(buildElement({ class: 'info' }));

	const textDetail = info.appendChild(buildElement({ class: 'text', text: '...' }));
	const progressDetail = info.appendChild(buildElement({ class: 'progress hidden' }));

	const bar = progressDetail.appendChild(buildElement({ class: 'bar' }));
	const fill = bar.appendChild(buildElement({ class: 'fill' }));
	const digits = progressDetail.appendChild(buildElement({ class: 'digits', text: '0%' }));

	/* create the actual notification and return the handler callback */
	const fadeOut = _state.pushNotification(upload);
	return (detail, status, total) => {
		/* update the content visibility and the body */
		if (typeof detail == 'number') {
			textDetail.classList.add('hidden');
			progressDetail.classList.remove('hidden');

			if (total == null) {
				const value = `${Math.round(detail * 100)}%`;
				fill.style.width = value;
				digits.innerText = value;
			}
			else {
				fill.style.width = `${Math.round((detail * 100) / total)}%`;
				digits.innerText = `${detail} / ${total}`;
			}
		}
		else {
			textDetail.classList.remove('hidden');
			progressDetail.classList.add('hidden');

			textDetail.innerText = detail;
		}

		/* update the colors and fading based on the status */
		if (status == null)
			return;
		textDetail.classList.add(status ? 'success' : 'failure');
		progressDetail.classList.add(status ? 'success' : 'failure');
		if (status)
			fadeOut();
	};
}
_state.pushTaskStatic = (caption, message, status) => {
	const update = _state.pushTaskStatus(caption);
	update(message, status);
}
_state.pushStaticText = (text, status) => {
	const element = buildElement({ text });
	if (status != null)
		element.classList.add(status ? 'success' : 'failure');

	const fadeOut = _state.pushNotification(element);
	if (status)
		fadeOut();
}
_state.makeLocation = (path, cb) => {
	const kind = (cb == null ? 'a' : 'div');
	const location = buildElement({ class: 'wrapper location' });

	/* add the home button */
	const home = location.appendChild(buildElement({ kind, class: 'button icon', child: _state.loadIcon('Home', 'home') }));

	/* update the logic for home */
	if (cb == null)
		home.href = _state.makePath(true, false);
	else if (path == '/')
		home.classList.add('disabled');
	else
		home.onclick = () => cb('/');

	/* add the buttons for the path components */
	for (let i = 1, end = 0; i < path.length; i = end + 1) {
		end = path.indexOf('/', i);
		if (end < 0)
			end = path.length;

		location.appendChild(buildElement({ class: 'separator', text: '>' }));
		const entry = location.appendChild(buildElement({ kind, class: 'button text', text: path.substring(i, end) }));

		/* wire up the button logic */
		if (cb == null)
			entry.href = _state.makePath(true, false, path.substring(0, end));
		else if (end < path.length)
			entry.onclick = () => cb(path.substring(0, end));
		else
			entry.classList.add('disabled');
	}

	/* register the location listener to ensure the location is scroll end-favoring (to preserve
	*	the closer parents on small views; initialize for initial load to be right-aligned) */
	let lastWidth = location.clientWidth;
	requestAnimationFrame(() => location.scrollLeft = location.scrollWidth - lastWidth);
	new ResizeObserver(() => {
		const width = location.clientWidth;
		if (width < lastWidth && location.scrollLeft + lastWidth >= location.scrollWidth)
			location.scrollLeft = location.scrollWidth - width;
		lastWidth = width;
	}).observe(location);

	return location;
}

_state.createMenuEntry = () => {
	const entry = buildElement({ class: 'button option' });
	entry.appendChild(buildElement({ class: 'icon' }));
	entry.appendChild(buildElement({ class: 'text' }));
	return entry;
}
_state.updateMenuLength = (element, length) => {
	/* format the list properly and ensure all existing elements are properly reset */
	while (element.children.length > length)
		element.lastChild.remove();
	for (const child of element.children) {
		child.children[0].innerText = '';
		child.children[1].classList = 'text';
		child.classList = 'button option';
	}
	while (element.children.length < length)
		element.appendChild(_state.createMenuEntry());
}
_state.hideOverlays = (skip) => {
	for (const name of ['menu', 'pick', 'remove']) {
		if (name != skip)
			_state.updateOverlay(`${name}-overlay`, null);
	}
}
_state.updateOverlay = (name, notify) => {
	const overlay = document.getElementById(name);

	/* hide all other overlays */
	if (notify != null)
		_state.hideOverlays(name);

	/* check if a notification callback has been registered and register the next callback */
	if (name in _state.overlay) {
		_state.overlay[name]();
		delete _state.overlay[name];
	}
	const show = (notify != null);
	if (show)
		_state.overlay[name] = notify;

	/* manually animate, due to changing the display type */
	if (show) {
		overlay.classList.remove('hidden');

		/* set the class-style again after finishing the animation, to
		*	ensure overlayed show/hide's finalize with the proper result */
		overlay.animate([
			{ opacity: '0', easing: 'ease-out' }, { opacity: '1' }
		], TRANSITION_OVERLAY_ANIMATION).onfinish = () => overlay.classList.remove('hidden');
		overlay.children[0].animate([
			{ transform: 'translateY(-20%)', easing: 'ease-out' }, { transform: 'translateY(0)' }
		], TRANSITION_OVERLAY_ANIMATION);
	}
	else {
		overlay.animate([
			{ opacity: '1', easing: 'ease-in' }, { opacity: '0' }
		], TRANSITION_OVERLAY_ANIMATION).onfinish = () => overlay.classList.add('hidden');
		overlay.children[0].animate([
			{ transform: 'translateY(0)', easing: 'ease-in' }, { transform: 'translateY(-20%)' }
		], TRANSITION_OVERLAY_ANIMATION);
	}
}
_state.showEntryMenu = (entry) => {
	let menuSize = 2, entryIndex = 2;
	if (_state.config.upload)
		menuSize += 1;
	if (_state.config.delete)
		menuSize += 1;
	if (_state.config.upload && _state.config.delete)
		menuSize += 2;
	if (navigator?.clipboard != null)
		++menuSize;

	/* initialize the menu caption and list size */
	const content = document.getElementById('menu-content');
	document.getElementById('menu-caption').classList.remove('hidden');
	document.getElementById('menu-name').innerText = entry.name;
	_state.updateMenuLength(content, menuSize);

	/* helper method to ensure the entry is still valid */
	let settled = false;
	const validateEntry = (checkSettled) => {
		if (checkSettled && settled) return false;
		if (_state.list.indexOf(entry) >= 0)
			return true;
		_state.pushStaticText(`[${entry.name}] does not exist anymore`, false);
		if (!settled)
			_state.updateOverlay('menu-overlay', null);
		return false;
	};

	/* register the common menu options */
	content.children[0].children[0].appendChild(_state.loadIcon('Open', 'open'));
	content.children[0].children[1].innerText = 'Open';
	content.children[0].onclick = () => {
		if (validateEntry(true))
			document.location = _state.makePath(true, true, entry.name);
	};
	content.children[1].children[0].appendChild(_state.loadIcon('Download', 'download'));
	content.children[1].children[1].innerText = 'Download';
	content.children[1].onclick = () => {
		if (!validateEntry(true)) return;
		_state.updateOverlay('menu-overlay', null);

		/* request the actual download of the content */
		const download = document.createElement('a');
		download.href = `${_state.makePath(true, true, entry.name)}?kind=${entry.kind}&download=true`;
		download.download = '';
		download.click();
	};

	/* register the copy-url interaction */
	if (navigator?.clipboard != null) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Clipboard', 'clipboard'));
		content.children[entryIndex].children[1].innerText = 'Copy URL';
		content.children[entryIndex++].onclick = () => {
			if (!validateEntry(true)) return;
			_state.updateOverlay('menu-overlay', null);
			navigator.clipboard.writeText(new URL(_state.makePath(true, true, entry.name), document.location).href)
				.then(() => _state.pushStaticText('Copied to Clipboard!', true))
				.catch(() => _state.pushStaticText('Failed writing to clipboard', false));
		};
	}

	/* register the modification interactions */
	if (_state.config.upload && _state.config.delete) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Rename', 'rename'));
		content.children[entryIndex].children[1].innerText = 'Rename';
		content.children[entryIndex++].onclick = () => {
			if (!validateEntry(true)) return;
			_state.updateOverlay('menu-overlay', null);

			/* start renaming the element */
			_state.renameAnyEntry(entry.html.name, () => validateEntry(false), (fileName) => {
				entry.html.name.innerText = entry.name;
				if (fileName != null && fileName != entry.name)
					console.log(`Rename [${_state.makePath(false, true, entry.name)}] to [${fileName}]`);
			});
		};
	}
	if (_state.config.upload) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Copy', 'copy'));
		content.children[entryIndex].children[1].innerText = 'Copy to...';
		content.children[entryIndex++].onclick = () => {
			if (!validateEntry(true)) return;
			_state.updateOverlay('menu-overlay', null);
			_state.showMoveCopyPicker(false, (path) => {
				if (!validateEntry(false)) return;
				if (path != _state.config.basePath)
					return console.log(`Copy [${_state.makePath(false, true, entry.name)}] to: ${path}`);

				/* find the temporary name to be used */
				let tempName = '';
				for (let i = 1; ; ++i) {
					tempName = `${entry.name} (${i})`;
					if (_state.list.findIndex((v) => v.name == tempName) < 0)
						break;
				}

				/* for an in-place copy, create a new temporary entry to be renamed */
				const fakeEntry = _state.createListEntry({ name: tempName, kind: entry.kind }, false);
				const host = document.getElementById('content');
				host.insertBefore(fakeEntry.html.row, host.children[0]);
				fakeEntry.html.row.scrollIntoView();
				++_state.fakeEntries;
				_state.updateList(null);

				/* start editing the new element */
				_state.renameAnyEntry(fakeEntry.html.name, () => true, (fileName) => {
					fakeEntry.html.row.remove();
					--_state.fakeEntries;
					_state.updateList(null);

					if (fileName != null && validateEntry(false))
						return console.log(`Copy [${_state.makePath(false, true, entry.name)}] to: ${_state.makePath(false, true, fileName)}`);
				});
			});
		};
	}
	if (_state.config.upload && _state.config.delete) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Move', 'move'));
		content.children[entryIndex].children[1].innerText = 'Move to...';
		content.children[entryIndex++].onclick = () => {
			if (!validateEntry(true)) return;
			_state.updateOverlay('menu-overlay', null);
			_state.showMoveCopyPicker(true, (path) => {
				if (validateEntry(false))
					console.log(`Move [${_state.makePath(false, true, entry.name)}] to: ${path}`);
			});
		};
	}

	/* register the delete interaction */
	if (_state.config.delete) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Delete', 'delete'));
		content.children[entryIndex].children[1].innerText = 'Delete';
		content.children[entryIndex].classList.add('delete');
		content.children[entryIndex++].onclick = () => {
			if (!validateEntry(true)) return;
			_state.updateOverlay('menu-overlay', null);

			/* ask the user if the deletion should actually be performed */
			_state.showDeleteConfirm(entry.name, () => {
				if (validateEntry(false))
					_state.removeContent(entry.name, (entry.kind == 'directory'));
			});
		};
	}

	/* show the actual menu */
	_state.updateOverlay('menu-overlay', () => { settled = true; });
}
_state.showCreateMenu = () => {
	if (!_state.config.upload)
		return _state.pushStaticText('Not allowed to upload content', false);

	/* initialize the menu caption and list size */
	const content = document.getElementById('menu-content');
	document.getElementById('menu-caption').classList.add('hidden');
	_state.updateMenuLength(content, 3);

	/* update the texts and icons */
	content.children[0].children[0].appendChild(_state.loadIcon('Directory', 'directory'));
	content.children[0].children[1].innerText = 'Create Directory';
	content.children[1].children[0].appendChild(_state.loadIcon('UploadFile', 'upload'));
	content.children[2].children[0].appendChild(_state.loadIcon('UploadFile', 'upload'));
	const row0 = buildElement();
	row0.appendChild(buildElement({ text: 'Upload Files', class: 'main' }));
	content.children[1].children[1].replaceChildren(row0);
	const row1 = buildElement();
	row1.appendChild(buildElement({ text: 'Upload Directory', class: 'main' }));
	content.children[2].children[1].replaceChildren(row1);

	/* add the size marker */
	if (_state.config.maxUploadSize != null) {
		const text = `Max. ${_state.formatSize(_state.config.maxUploadSize)} per file`;
		row0.appendChild(buildElement({ class: 'detail', text }));
		row1.appendChild(buildElement({ class: 'detail', text }));
	}

	/* show the actual menu */
	let settled = false;
	_state.updateOverlay('menu-overlay', () => { settled = true; });

	/* wire up the corresponding click logic */
	const processInputFiles = (input, directory) => {
		if (input.files == null) return;
		const list = [];

		/* collect the list of files (input only produces files) and process it */
		for (const file of input.files) {
			const path = (file.webkitRelativePath ?? '');
			list.push({ kind: 'file', size: file.size, path: `/${(path != '') ? path : file.name}`, file });
		}
		input.files = null;
		_state.uploadContent(list, (directory ? 'Selected directory' : 'Selected files'));
	};
	content.children[0].onclick = () => {
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		/* create the new fake list to be edited */
		const entry = _state.createListEntry({ name: '', kind: 'directory' }, false);
		const host = document.getElementById('content');
		host.insertBefore(entry.html.row, host.children[0]);
		entry.html.row.scrollIntoView();
		++_state.fakeEntries;
		_state.updateList(null);

		/* start editing the new element */
		_state.createDirectory(entry.html.name, _state.config.basePath, (promise) => {
			entry.html.row.remove();
			--_state.fakeEntries;
			_state.updateList(null);
			if (promise == null) return;

			/* add the entry preemtively to the list (ensure that a new list is created) */
			promise.then((fileName) => {
				if (_state.list.findIndex((v) => v.name == fileName) < 0)
					_state.updateList(_state.list.concat([{ name: fileName, kind: 'directory', size: 0, modified: 0 }]));
			}).catch(() => { });
		});
	};
	content.children[1].onclick = () => {
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.onchange = () => processInputFiles(input, false);
		input.click();
	};
	content.children[2].onclick = () => {
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		const input = document.createElement('input');
		input.type = 'file';
		input.webkitdirectory = true;
		input.onchange = () => processInputFiles(input, true);
		input.click();
	};
}
_state.showMoveCopyPicker = (move, callback) => {
	if (move ? (!_state.config.upload || !_state.config.delete) : (!_state.config.upload))
		return _state.pushStaticText(`Not allowed to ${move ? 'move' : 'copy'} content`, false);

	/* show the menu navigation and configure the confirm button */
	const navigation = document.getElementById('pick-navigation');
	const confirm = document.getElementById('pick-confirm');
	const content = document.getElementById('pick-content');
	confirm.innerText = (move ? 'Move Here' : 'Copy Here');

	/* construct the map of already fetched directories (cache them) */
	const baseList = [];
	for (const temp of _state.list) {
		if (temp.kind == 'directory')
			baseList.push(temp.name);
	}
	const fetched = { [_state.config.basePath]: baseList.sort() };

	/* setup helper functions for the dialog */
	let settled = false, busyTimer = null, cancelTask = () => { };
	const markAsBusy = () => {
		busyTimer = setTimeout(() => {
			if (settled) return;
			document.getElementById('pick-busy').classList.remove('hidden');
		}, DELAY_UNTIL_SPINNER);
	};
	const clearBusy = () => {
		if (busyTimer != null)
			clearTimeout(busyTimer);
		busyTimer = null;
		document.getElementById('pick-busy').classList.add('hidden');
	};
	const navigateDirectories = (target) => {
		if (settled || busyTimer != null)
			return;
		cancelTask();
		if (target in fetched)
			return updateView(target);
		markAsBusy();

		/* fetch the directory state from the server */
		_state.batch(() => {
			if (!settled)
				_state.fs.fetchDirectory(target);
		}).then((json) => {
			if (settled) return;
			clearBusy();

			/* collect the list of directories and update the view */
			const targetList = [];
			for (const name in json) {
				if (json[name].kind == 'directory')
					targetList.push(name);
			}
			fetched[target] = targetList.sort();
			updateView(target);
		}).catch((e) => {
			if (settled) return;
			_state.pushTaskStatic(`Reading [${target}]`, e, false);
			_state.updateOverlay('pick-overlay', null);
		});
	};
	const updateView = (path) => {
		const directories = fetched[path];

		/* update the confirmation button */
		if (move && path == _state.config.basePath)
			confirm.classList.add('disabled');
		else
			confirm.classList.remove('disabled');
		confirm.onclick = () => {
			if (settled) return;
			_state.updateOverlay('pick-overlay', null);
			callback(path);
		};

		/* construct the actual entries */
		_state.updateMenuLength(content, directories.length);
		for (let i = 0; i < directories.length; ++i) {
			content.children[i].children[0].appendChild(_state.loadIcon('Directory', 'directory'));
			content.children[i].children[1].classList.add('path');
			content.children[i].children[1].innerText = directories[i];
			content.children[i].onclick = () => navigateDirectories(buildPath(path, directories[i]));
		}

		/* check if the directory is empty */
		if (directories.length == 0)
			document.getElementById('pick-content-empty').classList.remove('hidden');
		else
			document.getElementById('pick-content-empty').classList.add('hidden');

		/* update the navigation and add the create-button */
		const location = _state.makeLocation(path, (target) => navigateDirectories(target));
		if (navigation.children.length == 1)
			navigation.insertBefore(location, navigation.children[0]);
		else
			navigation.replaceChild(location, navigation.children[0]);
		navigation.children[1].onclick = () => {
			cancelTask();
			if (settled || busyTimer != null)
				return;

			/* create the temporary fake entry to be used for the renaming */
			const fakeEntry = content.insertBefore(_state.createMenuEntry(), content.children[0] ?? null);
			fakeEntry.children[0].appendChild(_state.loadIcon('Directory', 'directory'));
			fakeEntry.children[1].classList.add('path');
			fakeEntry.scrollIntoView();
			document.getElementById('pick-content-empty').classList.add('hidden');

			/* try to create the actual directory (cannot have a busy-timer, if the
			*	promise is valid, as this implies that no cancel-task was called) */
			cancelTask = _state.createDirectory(fakeEntry.children[1], path, (promise) => {
				fakeEntry.remove();
				if (promise == null || settled)
					return;
				markAsBusy();

				/* await the completion of the creation */
				promise.then((fileName) => {
					if (settled) return;
					clearBusy();
					fetched[path].push(fileName);
					fetched[path].sort();
					updateView(path);

					/* check if it should also be pushed to the root list (ensure that a new list is created) */
					if (path == _state.config.basePath && _state.list.findIndex((v) => v.name == fileName) < 0)
						_state.updateList(_state.list.concat([{ name: fileName, kind: 'directory', size: 0, modified: 0 }]));
				}).catch(() => {
					if (settled) return;
					clearBusy();
				});
			});
		};
	};

	/* construct the initial list and show the actual menu */
	updateView(_state.config.basePath);
	_state.updateOverlay('pick-overlay', () => {
		settled = true;
		cancelTask();
		clearBusy();
	});
}
_state.showDeleteConfirm = (name, callback) => {
	document.getElementById('remove-name').innerText = _state.makePath(false, true, name);

	let settled = false;
	document.getElementById('remove-confirm').onclick = () => {
		if (settled) return;
		_state.updateOverlay('remove-overlay', null);
		callback();
	};

	_state.updateOverlay('remove-overlay', () => { settled = true; });
}
_state.renameAnyEntry = (element, exists, callback) => {
	let settled = false;
	const checkOperation = () => {
		if (settled) return false; settled = true;
		return exists();
	};
	const cleanupRename = (result) => {
		element.contentEditable = false;
		element.blur();
		callback(result);
	};
	const confirmRename = () => {
		window.getSelection().removeAllRanges();
		const fileName = element.innerText.trim();

		/* check if the name is valid */
		if (fileName.match(VALID_NAME_REGEX))
			return cleanupRename(fileName);
		_state.pushStaticText(`[${fileName}] is not a valid name (No: \\ / ? : * " < > | )`, false);
		return cleanupRename(null);
	};

	/* check if the document is not focused, and the rename should just be ignored/silently discarded */
	if (!document.hasFocus()) {
		console.log(`Ignoring renaming [${element.innerText}] as the document is not focused`);
		return cleanupRename(null);
	}

	/* select the entire content of the element */
	window.getSelection().removeAllRanges();
	const range = document.createRange();
	range.selectNodeContents(element);
	window.getSelection().addRange(range);

	/* temporarily start editing the single element */
	element.contentEditable = true;
	element.focus({ preventScroll: true });
	element.onblur = () => {
		if (checkOperation())
			confirmRename();
	}

	/* register the abort handler */
	element.onkeydown = (e) => {
		if (e.key != 'Escape' && e.key != 'Enter') return;
		if (!checkOperation()) return;
		e.stopPropagation();
		e.preventDefault();
		if (e.key == 'Escape')
			cleanupRename();
		else
			confirmRename();
	};

	/* return the abort callback */
	return () => {
		if (settled) return; settled = true;
		cleanupRename(null);
	};
}
_state.createListEntry = (params, links) => {
	const row = buildElement({ class: 'row button' });

	const entry = row.appendChild(buildElement({ kind: (links ? 'a' : 'div'), class: 'entry' }));
	if (links)
		entry.href = _state.makePath(true, true, params.name);

	const icon = entry.appendChild(buildElement({ class: 'icon' }));
	if (params.kind == 'directory')
		icon.appendChild(_state.loadIcon('Directory', 'directory'))
	else
		icon.appendChild(_state.loadIcon('File', 'file'))

	const details = entry.appendChild(buildElement({ class: 'details' }));
	const name = details.appendChild(buildElement({ class: 'name', text: params.name }));
	const info = details.appendChild(buildElement({ class: 'info' }));
	const size = info.appendChild(buildElement({ text: '-' }));
	const date = info.appendChild(buildElement({ text: '-' }));
	const menu = row.appendChild(buildElement({ class: 'button option', child: _state.loadIcon('Menu', 'menu') }));

	return { ...params, html: { row, name, size, date, menu } };
}
_state.updateList = (content) => {
	const host = document.getElementById('content');

	/* sort the content according to the presentation order */
	const compare = (a, b) => {
		if (a.kind != b.kind)
			return (a.kind == 'directory' ? -1 : 1);
		return (a.name < b.name ? -1 : (a.name == b.name ? 0 : 1));
	};
	if (content != null)
		content.sort(compare);

	/* iterate over the current list and content list, and synchronize them */
	let prev = 0, next = 0;
	if (content != null) while (true) {
		const hasPrev = (prev < _state.list.length), hasNext = (next < content.length);
		if (!hasPrev && !hasNext)
			break;
		const cmp = (hasNext ? (hasPrev ? compare(_state.list[prev], content[next]) : 1) : -1);

		/* check if an entry needs to be removed (remove from list before removing from tree to ensure 'onblur' can detect the removal) */
		if (cmp < 0) {
			const row = _state.list.splice(prev, 1)[0].html.row;
			host.removeChild(row);
			continue;
		}

		/* check if an entry needs to be added */
		let entry = null;
		if (cmp > 0) {
			entry = _state.createListEntry(content[next], true);
			host.insertBefore(entry.html.row, (hasPrev ? _state.list[prev].html.row : null));
			_state.list.splice(prev, 0, entry);
		}
		else {
			entry = _state.list[prev];
			entry.size = content[next].size;
			entry.modified = content[next].modified;
		}

		/* patch details up accordingly (must now exist in both lists, as either matched or newly created) */
		if (content[next].kind == 'directory')
			entry.html.size.innerText = `${content[next].size} Items`;
		else
			entry.html.size.innerText = `${_state.formatSize(content[next].size)}`;
		if (content[next].modified == 0)
			entry.html.date.innerText = '-';
		else {
			const date = new Date(content[next].modified);
			entry.html.date.innerText = `${date.toLocaleTimeString()} ${date.toLocaleDateString()}`;
		}

		/* patch the menu button and right click */
		entry.html.menu.onclick = () => _state.showEntryMenu(entry);
		entry.html.menu.oncontextmenu = (e) => e.stopPropagation();
		entry.html.row.oncontextmenu = (e) => {
			e.preventDefault();
			_state.showEntryMenu(entry);
		};
		++next, ++prev;
	}

	/* check if the list is empty and add the placeholder */
	if (_state.list.length == 0 && _state.fakeEntries == 0)
		document.getElementById('content-empty').classList.remove('hidden');
	else
		document.getElementById('content-empty').classList.add('hidden');
	console.log(`content list has been updated to ${_state.list.length + _state.fakeEntries} entries...`);
}

_state.createDirectory = (element, path, callback) => {
	element.innerText = 'New Directory';

	return _state.renameAnyEntry(element, () => true, (fileName) => {
		if (fileName == null)
			return callback(null);

		const fullPath = buildPath(path, encodeURIComponent(fileName));
		callback(new Promise((resolve, reject) => {
			const update = _state.pushTaskStatus(`Create: [${fullPath}]`);
			update('Creating...', null);
			_state.batch(() => _state.fs.makeDirectory(fullPath, false))
				.then(() => {
					update('Created!', true);
					resolve(fileName);
				})
				.catch((e) => {
					update(e, false);
					return reject();
				});
		}));
	});
}
_state.uploadContent = async (list, what) => {
	if (list.length == 0)
		return;
	if (!_state.config.upload)
		return _state.pushStaticText('Not allowed to upload content', false);

	/* check if its a complex list (larger than batch-size or directories need to be created), in which case they have to be fetched first */
	let totalUpdate = null, totalList = [];
	if (list.length > FILE_OPERATION_BATCH_SIZE || list.findIndex((e) => e.kind == 'directory' || e.path.lastIndexOf('/') > 0) >= 0) {
		totalUpdate = _state.pushTaskStatus(`Upload: [${what}]`);
		totalUpdate('Calculating...', null);

		/* helper to ensure all directories are created */
		let directories = {}, initFailed = false;
		const fetchDirectory = (path) => {
			if (initFailed) return null;

			/* the root is always considered valid */
			if (path.length <= 1)
				return null;
			if (path in directories)
				return directories[path];
			const parent = path.substring(0, path.lastIndexOf('/'));

			/* check if its an entry in the current list, which is implicitly considered to exist */
			if (parent == '') {
				const next = path.substring(1);
				const index = _state.list.findIndex((e) => e.name == next);
				if (index >= 0) {
					if (_state.list[index].kind == 'directory')
						return (directories[path] = null);
					totalUpdate(`Path [${path}] is not a directory`, false);
					initFailed = true;
					return null;
				}
			}

			/* ensure that the parent exists (before writing self to the list) and then create the new entry */
			totalList.push({ kind: 'directory', path, parent: fetchDirectory(parent) });
			return (directories[path] = totalList.length - 1);
		};
		const unpackEntry = async (entry) => {
			/* add the file and its dependency onto the parent */
			if (entry.kind == 'file') {
				const parent = fetchDirectory(entry.path.substring(0, entry.path.lastIndexOf('/')));
				totalList.push({ kind: 'file', path: entry.path, size: entry.size, parent, file: entry.file });
				return;
			}

			/* add the directory and process all children */
			fetchDirectory(entry.path);
			for (const child of await entry.children()) {
				if (initFailed) return;
				await unpackEntry(child);
			}
		};

		/* collect all of the list entries */
		for (const entry of list) {
			await unpackEntry(entry);
			if (initFailed)
				return;
		}
		totalUpdate(0, null, totalList.length);
	}
	else
		totalList = list;

	/* helper functions to perform uploads */
	const uploadFile = async (file) => {
		const update = _state.pushTaskStatus(`Upload: [${file.path}]`);

		/* check if the file is too large (does not contribute to the total-failed counter) */
		if (_state.config.maxUploadSize != null && file.size > _state.config.maxUploadSize) {
			update(`Skip: too large [${_state.formatSize(file.size)} > ${_state.formatSize(_state.config.maxUploadSize)}]`, false);
			return null;
		}
		update(0, null);

		/* try to perform the actual upload */
		let success = false;
		try {
			await _state.fs.upload(_state.makePath(false, true, file.path), (p) => update(p, null), file.file);
			success = true;

			/* add the entry preemtively to the list (ensure that a new list is created) */
			const name = file.path.substring(file.path.lastIndexOf('/') + 1);
			if (file.path.length == name.length + 1)
				_state.updateList(_state.list.concat([{ name, kind: 'file', size: file.size, modified: 0 }]));
			update('Successfully uploaded!', true);
		}
		catch (e) {
			update(e, false);
		}
		return success;
	};
	const uploadDirectory = async (path) => {
		/* try to create the new directory */
		let success = false;
		try {
			await _state.fs.makeDirectory(_state.makePath(false, true, path), true);
			success = true;

			/* check if this is a root directory and preemtively add the entry to the list (ensure that a new list is created)  */
			const name = path.substring(path.lastIndexOf('/') + 1);
			if (path.length == name.length + 1)
				_state.updateList(_state.list.concat([{ name, kind: 'directory', size: 0, modified: 0 }]));
		}
		catch (e) {
			_state.pushTaskStatic(`Create: [${path}]`, e, false);
		}
		return success;
	};

	/* iterate over the list and collect all of the corresponding upload-promises (they take care of batching themselves) */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		let resolver = null;
		entry.promise = new Promise((res) => resolver = res);

		promises.push(_state.batch(async () => {
			/* check if the entry has a dependency and await it (mark the object as skipped if the parent failed; not if already failed) */
			if (entry.parent != null && !await totalList[entry.parent].promise) {
				if (totalFailed <= FILE_MAX_FAILURES)
					++totalSkipped;
				return resolver(false);
			}

			/* check if the operation has already failed, in which case nothing
			*	more will be performed (i.e. just silently skip the task) */
			if (totalFailed > FILE_MAX_FAILURES)
				return resolver(false);

			/* try to perform the actual upload */
			let result = null;
			if (entry.kind == 'file')
				result = await uploadFile(entry);
			else
				result = await uploadDirectory(entry.path);
			resolver(result ?? false);

			/* update the overall task counter */
			if (result == null) {
				++totalSkipped;
				return;
			}
			++totalPerformed;
			if (!result)
				++totalFailed;
			if (totalUpdate != null)
				totalUpdate(totalPerformed, null, totalList.length);
		}));
	}
	await Promise.all(promises);

	/* log the final status message */
	if (totalUpdate == null)
		return;
	if (totalFailed > FILE_MAX_FAILURES)
		totalUpdate(`Aborted due to too many failed uploads (${totalFailed} failed out of ${totalPerformed} performed of required ${totalList.length})`, false);
	else if (totalFailed > 0)
		totalUpdate(`Failed to upload ${totalFailed} out of ${totalPerformed} (${totalSkipped} skipped)`, false);
	else
		totalUpdate('Successfully uploaded!', true);
}
_state.removeContent = async (name, directory) => {
	if (!_state.config.delete)
		return _state.pushStaticText('Not allowed to delete content', false);
	console.log(`Removing [${_state.makePath(false, true, name)}]...`);

	/* setup the notification */
	const totalUpdate = _state.pushTaskStatus(`Remove: [${name}]`);
	totalUpdate('Calculating...', null);

	/* recursively collect the list of all files and directories to be removed */
	const totalList = [];
	if (directory) {
		let initFailed = false;
		const fetchAndUpdate = async (path) => {
			if (initFailed) return;

			/* fetch the content list */
			let content = null;
			try { content = await _state.batch(() => _state.fs.fetchDirectory(path)); }
			catch (e) {
				if (!initFailed)
					totalUpdate(`Reading [${path}]: ${e}`, false);
				initFailed = true;
				return;
			}
			if (initFailed) return;

			/* recursively visit all children (before inserting self, to ensure the children are ahead in the list) */
			const promises = [], children = [];
			for (const name in content) {
				if (initFailed) return;

				const childPath = buildPath(path, name);
				if (content[name].kind == 'file') {
					children.push(totalList.length);
					totalList.push({ path: childPath, kind: 'file' });
				}
				else
					promises.push(fetchAndUpdate(childPath));
			}

			/* await the children and then push itself onto the list (with the indices of all children) */
			totalList.push({ path, kind: 'directory', children: children.concat(await Promise.all(promises)) });
			return totalList.length - 1;
		};
		await fetchAndUpdate(_state.makePath(false, true, name));
		if (initFailed)
			return;
	}
	else
		totalList.push({ path: _state.makePath(false, true, name), kind: 'file' });
	totalUpdate(0, null, totalList.length);

	/* iterate over the list and collect all of the corresponding delete-promises (they take care of batching themselves) */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		let resolver = null;
		entry.promise = new Promise((res) => resolver = res);

		promises.push(_state.batch(async () => {
			/* check if this is a directory, in which case all of its children
			*	need to be awaited, to ensure they have been properly deleted */
			if (entry.kind == 'directory') {
				for (const index of entry.children) {
					if (await totalList[index].promise)
						continue;

					/* mark the directory as skipped, as the child failed (not if already failed) */
					if (totalFailed <= FILE_MAX_FAILURES)
						++totalSkipped;
					return resolver(false);
				}
			}

			/* check if the operation has already failed, in which case nothing
			*	more will be performed (i.e. just silently skip the task) */
			if (totalFailed > FILE_MAX_FAILURES)
				return resolver(false);

			/* try to perform the actual deletion */
			let success = false;
			try {
				await _state.fs.remove(entry.path, entry.kind);
				success = true;
			}
			catch (e) {
				_state.pushTaskStatic(`Remove: [${entry.path}]`, e, false);
				++totalFailed;
			}
			totalUpdate(++totalPerformed, null, totalList.length);
			resolver(success);
		}));
	}
	await Promise.all(promises);

	/* log the final message and optionally preemtively remove the entry from the list (ensure that a new list is created; skipped can only be > 0, if failed is > 0) */
	if (totalFailed > FILE_MAX_FAILURES)
		totalUpdate(`Aborted due to too many failed deletions (${totalFailed} failed out of ${totalPerformed} performed of required ${totalList.length})`, false);
	else if (totalFailed > 0)
		totalUpdate(`Failed to delete ${totalFailed} out of ${totalList.length} (Skipped: ${totalSkipped})`, false);
	else {
		_state.updateList(_state.list.filter((entry) => entry.name != name));
		totalUpdate('Successfully removed!', true);
	}
}

window.onload = () => {
	/* parse the initial configuration */
	_state.config.delete = (__LOAD_PARAMS__?.delete ?? false);
	_state.config.upload = (__LOAD_PARAMS__?.upload ?? false);
	_state.config.maxUploadSize = (_state.config.upload ? (__LOAD_PARAMS__?.maxUploadSize ?? null) : 0);
	if (_state.config.maxUploadSize != null && _state.config.maxUploadSize <= 0)
		_state.config.upload = false;
	_state.config.basePath = (__LOAD_PARAMS__?.basePath ?? '/bad_path');
	_state.config.rootPath = (__LOAD_PARAMS__?.rootPath ?? '/bad_path');
	_state.config.icons = (__LOAD_PARAMS__?.icons ?? {});

	/* setup the initial icons to be loaded */
	document.getElementById('button-parent').appendChild(_state.loadIcon('Parent', 'back'));
	document.getElementById('create-button').appendChild(_state.loadIcon('Create', 'create'));
	document.getElementById('pick-create').appendChild(_state.loadIcon('Create', 'create'));

	/* build the location and setup the references */
	document.getElementById('navigation').appendChild(_state.makeLocation(_state.config.basePath, null));
	if (_state.config.basePath == '/')
		document.getElementById('button-parent').classList.add('disabled');
	else
		document.getElementById('button-parent').href = _state.makePath(true, false, _state.config.basePath.substring(0, _state.config.basePath.lastIndexOf('/')));

	/* register the drag-and-drop handlers for the UI */
	if (_state.config.upload) {
		const dropDetector = document.getElementById('body');
		const dropZone = document.getElementById('drop-zone');
		let dropCountDepth = 0;

		dropDetector.ondragenter = (e) => {
			if (event.dataTransfer?.types?.includes('Files') !== true) return;
			e.preventDefault();
			if (dropCountDepth++ == 0)
				dropZone.classList.add('expand');
		};
		dropDetector.ondragleave = (e) => {
			e.preventDefault();
			if (dropCountDepth > 0 && --dropCountDepth == 0)
				dropZone.classList.remove('expand');
		};
		dropDetector.ondragover = (e) => {
			if (event.dataTransfer?.types?.includes('Files') !== true) return;
			e.preventDefault();
		}
		dropDetector.ondrop = (e) => {
			if (event.dataTransfer?.types?.includes('Files') !== true) return;
			e.preventDefault();
			dropCountDepth = 0;
			dropZone.classList.remove('expand');

			/* helper to recursively unpack the tree */
			const unpackEntry = async (entry, parent) => {
				const path = `${parent}/${entry.name}`;

				/* check if its a file, and await its stats */
				if (entry.isFile) {
					try {
						const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
						return { kind: 'file', path, size: file.size, file };
					}
					catch (_) {
						_state.pushStaticText(`Error processing dropped file [${path}]`, false);
						return null;
					}
				}
				else if (!entry.isDirectory)
					return null;

				/* create the async children reader */
				const children = async () => {
					const reader = entry.createReader(), list = [];
					while (true) {
						let entries = null;
						try { entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject)); } catch (_) {
							_state.pushStaticText(`Error processing children of dropped directory [${path}]`, false);
							return [];
						}

						if (entries.length == 0)
							return list;
						for (const child of entries) {
							const processed = await unpackEntry(child, path);
							if (processed != null)
								list.push(processed);
						}
					}
				};
				return { kind: 'directory', path, children };
			};

			/* collect the async list of entries (as awaiting may clear the transfer list) */
			const entries = [], list = [];
			for (const item of e.dataTransfer.items) {
				const entry = item.webkitGetAsEntry();
				if (entry == null)
					continue;

				entries.push((async () => {
					const temp = await unpackEntry(entry, '');
					if (temp != null)
						list.push(temp);
				})());
			}

			/* collect the list of uploads and trigger them */
			(async () => {
				for (const entry of entries)
					await entry;
				_state.uploadContent(list, 'Dropped content');
			})();
		};

		/* update the drop animations and add the size constraints */
		dropZone.style.setProperty('--drop-zone-animations', `${DROP_ZONE_ANIMATION}ms`);
		if (_state.config.maxUploadSize != null)
			document.getElementById('drop-detail').innerText = `(Max. ${_state.formatSize(_state.config.maxUploadSize)})`;

		/* show and wire up the create button */
		document.getElementById('create-wrap').classList.remove('hidden');
		document.getElementById('create-button').onclick = () => _state.showCreateMenu();
	}

	/* register all relevant overlay key handler */
	for (const name of ['remove', 'menu', 'pick']) {
		const overlay = document.getElementById(`${name}-overlay`);
		overlay.children[0].onmousedown = (e) => e.stopPropagation();
		overlay.onmousedown = (e) => {
			e.preventDefault();
			_state.updateOverlay(`${name}-overlay`, null);
		};
		document.getElementById(`${name}-abort`).onclick = () => _state.updateOverlay(`${name}-overlay`, null);
	}

	/* register convenience handlers for overlays */
	document.onkeydown = (e) => {
		if (e.key == 'Escape')
			_state.hideOverlays();
	};

	/* load the initial content list */
	const initList = [];
	for (const name in __LOAD_PARAMS__?.content ?? {})
		initList.push({ name, ...__LOAD_PARAMS__.content[name] });
	_state.updateList(initList);
}

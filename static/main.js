/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

const REMOVE_NOTIFICATION_ANIMATION = 35;
const TRANSITION_OVERLAY_ANIMATION = 30;
const FADE_NOTIFICATION_ANIMATION = 3000;
const MAX_DELETE_FAILURES = 12;
const FILE_OPERATION_BATCH_SIZE = 8;
const DELAY_UNTIL_SPINNER = 150;
const DROP_ZONE_ANIMATION = 150;
const VALID_NAME_REGEX = /^[^\x00-\x1f\x7f/\\\?:\*"<>\|]+$/;
const UNIT_PREFIX_LIST = [[1_000_000_000_000_000, 'P'], [1_000_000_000_000, 'T'], [1_000_000_000, 'G'], [1_000_000, 'M'], [1_000, 'K'], [1, '']];
const _state = { list: [], fakeEntries: 0, loadedIcons: {}, config: {}, overlay: {} };

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

_state.makePath = (root, base, ...paths) => {
	const p0 = (root ? _state.config.rootPath : '/'), p1 = (base ? _state.config.basePath : '/');
	return buildPath(p0, p1, ...paths);
}
_state.formatSize = (size) => {
	for (const option of UNIT_PREFIX_LIST) {
		if (size < option[0] && option[0] > 0)
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
		console.log('Download!');
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
		input.type = 'file', input.multiple = true, input.onchange = () => {
			for (const file of input.files)
				_state.uploadFile(file, file.name, file.size);
			input.value = '';
		};
		input.click();
	};
	content.children[2].onclick = () => {
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		const input = document.createElement('input');
		input.type = 'file', input.webkitdirectory = true, input.onchange = () => {
			for (const file of input.files)
				_state.uploadFile(file, file.name, file.size);
			input.value = '';
		};
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
	const failFetch = (msg) => {
		if (settled) return;
		_state.pushStaticText(msg, false);
		_state.updateOverlay('pick-overlay', null);
	};
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
		fetch(`${_state.makePath(true, false, target)}?raw=true`)
			.then((resp) => {
				if (settled) return;

				if (!resp.ok)
					return failFetch(`Error reading directory:\n${resp.statusText}`);
				if (resp.headers.has('content-type') && !resp.headers.get('content-type').startsWith('application/json'))
					return failFetch('Unexpected server response');
				resp.json().then((content) => {
					console.log(`Directory [${target}] fetched`);
					if (settled) return;
					clearBusy();

					/* collect the list of directories and update the view */
					const targetList = [];
					for (const name in content) {
						if (content[name].kind == 'directory')
							targetList.push(name);
					}
					fetched[target] = targetList.sort();
					updateView(target);
				}).catch(() => failFetch('Malformed server response'));
			})
			.catch(() => failFetch('Network error'));
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

		callback(new Promise((resolve, reject) => {
			const update = _state.pushTaskStatus(`Create Directory: ${fileName}`);
			update('Creating...', null);
			fetch(_state.makePath(true, false, path, `${encodeURIComponent(fileName)}?kind=directory`), { method: 'POST' })
				.then((resp) => {
					if (!resp.ok) {
						update(`Error: ${resp.statusText}`, false);
						return reject();
					}
					update('Created!', true);
					resolve(fileName);
				})
				.catch(() => {
					update('Network error', false);
					return reject();
				});
		}));
	});
}
_state.removeContent = async (name, directory) => {
	if (!_state.config.delete)
		return _state.pushStaticText('Not allowed to delete content', false);
	console.log(`Removing [${_state.makePath(false, true, name)}]...`);

	/* setup the notification */
	const totalUpdate = _state.pushTaskStatus(`Remove: ${name}`);
	totalUpdate('Calculating...', null);

	/* failure helper for the initialization phase */
	let initFailed = false;
	const handleError = (msg) => {
		if (!initFailed)
			totalUpdate(msg, false);
		initFailed = true;
	};

	/* recursively collect the list of all files and directories to be removed */
	const totalList = [];
	if (directory) {
		const fetchAndUpdate = async (path) => {
			if (initFailed) return;

			/* fetch the content list */
			let response = null, content = null;
			try {
				response = await fetch(`${_state.makePath(true, false, path)}?raw=true`);
				if (!response.ok)
					return handleError(`Error reading [${path}]: ${response.statusText}`);
			}
			catch (_) {
				return handleError('Network error');
			}

			/* parse the content list */
			if (response.headers.has('content-type') && !response.headers.get('content-type').startsWith('application/json'))
				return handleError('Unexpected server response');
			try { content = await response.json() }
			catch (_) {
				return handleError('Malformed server response');
			}

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

	/* iterate over the list and remove the content */
	let batched = [], totalSuccess = 0, totalPerformed = 0, deleteFailed = false;
	for (let i = 0; i < totalList.length; ++i) {
		let entry = totalList[i], resolver = null;
		entry.promise = new Promise((res) => resolver = res);

		batched.push((async () => {
			/* check if this is a directory, in which case all of its children
			*	need to be awaited, to ensure they have been properly deleted */
			if (entry.kind == 'directory') {
				for (const index of entry.children)
					await totalList[index].promise;
			}

			/* try to perform the actual deletion */
			if (deleteFailed)
				return resolver();
			try {
				const response = await fetch(`${_state.makePath(true, false, entry.path)}?kind=${entry.kind}`, { method: 'DELETE' });
				if (response.ok)
					++totalSuccess;
				else
					_state.pushStaticText(`Failed to delete [${entry.path}]:\n${response.statusText}`, false);
			}
			catch (_) { _state.pushStaticText(`Failed to delete [${entry.path}]:\nNetwork error`, false); }

			/* mark this fetch as completed */
			totalUpdate(++totalPerformed, null, totalList.length);
			deleteFailed = (deleteFailed || (totalPerformed - totalSuccess > MAX_DELETE_FAILURES));
			resolver();
		})());

		/* check if the batch should be awaited again and if the operation has failed */
		if (i + 1 < totalList.length && (i + 1) % FILE_OPERATION_BATCH_SIZE != 0 && !deleteFailed)
			continue;
		await Promise.all(batched);
		batched = [];
		if (deleteFailed)
			break;
	}

	/* log the final message and optionally preemtively remove the entry from the list (ensure that a new list is created) */
	if (deleteFailed)
		totalUpdate(`Aborted due to too many failed deletions (${totalPerformed - totalSuccess} failed out of ${totalPerformed} performed of required ${totalList.length})`, false);
	else if (totalSuccess < totalPerformed)
		totalUpdate(`Failed to delete ${totalPerformed - totalSuccess} out of ${totalList.length}`, false);
	else {
		_state.updateList(_state.list.filter((entry) => entry.name != name));
		totalUpdate('Successfully removed!', true);
	}
}

_state.uploadFile = (file, fileName, fileSize) => {
	if (!_state.config.upload)
		return _state.pushStaticText('Not allowed to upload content', false);
	console.log(`uploading [${fileName}] of size [${fileSize}]...`);

	const update = _state.pushTaskStatus(`Upload: ${fileName}`);
	if (fileSize > _state.config.maxUploadSize)
		return update(`Too large [${_state.formatSize(fileSize)}]`, false);
	update(0, null);

	const xhr = new XMLHttpRequest();
	xhr.open('POST', `${_state.config.basePath}/${encodeURIComponent(fileName)}`, true);
	xhr.upload.onprogress = (e) => {
		update(e.loaded / fileSize, null);
	};
	xhr.onload = () => {
		if (xhr.status < 200 || xhr.status >= 300)
			return update(`Error: ${xhr.statusText}`, false);

		/* add the entry preemtively to the list (ensure that a new list is created) */
		_state.updateList(_state.list.concat([{ name: fileName, kind: 'file', size: fileSize, modified: 0 }]));
		update('Uploaded!', true);
	};
	xhr.onerror = () => update('Network error', false);
	xhr.send(file);
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
			for (const item of e.dataTransfer.items) {
				const entry = item.webkitGetAsEntry();
				const file = item.getAsFile();
				if (entry != null && entry.isFile && file != null)
					_state.uploadFile(file, file.name, file.size);
			}
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

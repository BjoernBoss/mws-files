/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

const REMOVE_NOTIFICATION_ANIMATION = 25;
const FADE_NOTIFICATION_ANIMATION = 3500;
const TRANSITION_OVERLAY_ANIMATION = 40;
const DROP_ZONE_ANIMATION = 150;
const COLOR_UI_SUCCESS = '#30a080';
const COLOR_UI_ERROR = '#b05050';
const _state = { list: [], loadedIcons: {}, config: {} };

_state.loadIcon = (placeholder, name) => {
	/* load the icons manually to ensure they are placed in-place and can be CSS modified */
	const element = document.createElement('div');
	element.classList.add('load-icon');

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

	/* setup the close icon and ensure that failure is logged as few times as
	*	possible (as every notification would otherwise trigger the failure log) */
	const close = document.createElement('div');
	close.classList.add('button');
	close.appendChild(_state.loadIcon('Close', 'close'));

	const entry = document.createElement('div');
	entry.classList.add('entry');

	const content = document.createElement('div');
	content.classList.add('content');
	content.appendChild(body);

	entry.appendChild(content);
	entry.appendChild(close);

	host.appendChild(entry);

	/* register the animated close handler and the phase-out handler */
	let faded = false, closed = false;
	close.onclick = () => {
		if (closed) return; closed = true;

		/* manually animate, due to unknown initial height */
		entry.animate([
			{ height: `${entry.clientHeight}px`, easing: 'ease-in' },
			{ height: '0', paddingTop: '0', paddingBottom: '0' }
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

_state.makeUploadProgress = (caption) => {
	const upload = document.createElement('div');
	upload.classList.add('upload');

	const name = document.createElement('div');
	name.innerText = caption;
	name.classList.add('text');

	const htmlStatus = document.createElement('div');
	htmlStatus.classList.add('status');

	upload.appendChild(name);
	upload.appendChild(htmlStatus);

	const bar = document.createElement('div');
	bar.classList.add('bar');
	const fill = document.createElement('div');
	fill.classList.add('fill');
	bar.appendChild(fill);

	const textProgress = document.createElement('div');
	textProgress.classList.add('progress', 'state');
	textProgress.innerText = '0%';

	htmlStatus.appendChild(bar);
	htmlStatus.appendChild(textProgress);

	/* setup the callback to report progress and success/failure */
	const callback = (detail, status) => {
		if (status == null) {
			const value = `${Math.round(detail * 100)}%`;
			fill.style.width = value;
			textProgress.innerText = value;
			return;
		}

		htmlStatus.removeChild(bar)
		textProgress.classList.remove('progress');
		textProgress.classList.add('text');
		textProgress.style.color = (status ? COLOR_UI_SUCCESS : COLOR_UI_ERROR);
		textProgress.innerHTML = detail;
	};
	return [upload, callback];
}
_state.makeDelayedStatus = (caption) => {
	const upload = document.createElement('div');
	upload.classList.add('upload');

	const name = document.createElement('div');
	name.innerText = caption;
	name.classList.add('text');

	const textStatus = document.createElement('div');
	textStatus.innerText = '...';
	textStatus.classList.add('text', 'state');

	upload.appendChild(name);
	upload.appendChild(textStatus);

	/* setup the callback to report progress and success/failure */
	const callback = (detail, status) => {
		textStatus.innerText = detail;
		if (status != null)
			textStatus.style.color = (status ? COLOR_UI_SUCCESS : COLOR_UI_ERROR);
	};
	return [upload, callback];
}
_state.makeStaticText = (text, status) => {
	const element = document.createElement('div');
	element.innerText = text;
	if (status != null)
		element.style.color = (status ? COLOR_UI_SUCCESS : COLOR_UI_ERROR);
	return element;
}

_state.showMenu = (name, entries) => {
	if (name == null)
		document.getElementById('menu-name').classList.add('hidden');
	else {
		document.getElementById('menu-name').classList.remove('hidden');
		document.getElementById('menu-name').innerText = name;
	}
	const content = document.getElementById('menu-content');

	/* iterate over the entries and add them */
	let index = 0;
	for (const entry of entries) {
		if (index >= content.children.length) {
			const option = document.createElement('div');
			option.classList.add('button');
			content.appendChild(option);

			const text = document.createElement('div');
			option.appendChild(text);

			const icon = document.createElement('div');
			icon.style.backgroundColor = 'red';
			icon.style.width = '20px';
			icon.style.height = '20px';
			icon.style.marginLeft = '20px';
			option.appendChild(icon);
		}

		content.children[index].children[0].innerText = entry[0];
		content.children[index].onclick = () => {
			_state.updateOverlay('menu-overlay', false);
			entry[1]();
		}
		++index;
	}

	/* remove any remaining entries and show the actual menu */
	while (index < content.children.length)
		content.lastChild.remove();
	_state.updateOverlay('menu-overlay', true);
}
_state.updateOverlay = (name, show) => {
	const overlay = document.getElementById(name);

	/* manually animate, due to changing the display type */
	if (show) {
		overlay.classList.remove('hidden');

		/* set the class-style again after finishing the animation, to
		*	ensure overlayed show/hide's finalize with the proper result */
		overlay.animate([
			{ opacity: '0', paddingBottom: '5%', easing: 'ease-in' },
			{ opacity: '1', paddingBottom: '0' }
		], TRANSITION_OVERLAY_ANIMATION).onfinish = () => overlay.classList.remove('hidden');
	}
	else {
		overlay.animate([
			{ opacity: '1', paddingBottom: '0', easing: 'ease-out' },
			{ opacity: '0', paddingBottom: '5%' }
		], TRANSITION_OVERLAY_ANIMATION).onfinish = () => overlay.classList.add('hidden');
	}
}
_state.showEntryMenu = (name) => {
	_state.showMenu(name, [
		['Download', () => { }],
		['Rename', () => { }],
		['Delete', () => { }],
		['Open', () => { }],
		['Copy URL', () => { }]
	]);
}

_state.uploadFile = (file, fileName, fileSize) => {
	if (!_state.config.upload) {
		_state.pushNotification(_state.makeStaticText('Not allowed to upload content', false));
		return;
	}
	console.log(`uploading [${fileName}] of size [${fileSize}]...`);

	const [element, update] = _state.makeUploadProgress(`Upload: ${fileName}`);
	const fadeOut = _state.pushNotification(element);
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

		/* add the entry preemtively to the list */
		_state.updateList(_state.list.concat([{ name: fileName, kind: 'file', size: fileSize }]));
		update('Uploaded!', true);
		fadeOut();
	};
	xhr.onerror = () => update('Network error', false);
	xhr.send(file);
}
_state.removeFile = (name) => {
	if (!_state.config.delete) {
		_state.pushNotification(_state.makeStaticText('Not allowed to remove content', false));
		return;
	}
	console.log(`confirming removing [${name}]...`);
	document.getElementById('remove-name').innerText = name;
	_state.updateOverlay('remove-overlay', true);

	document.getElementById('remove-confirm').onclick = () => {
		console.log(`removing [${name}]...`);
		_state.updateOverlay('remove-overlay', false);

		const [element, update] = _state.makeDelayedStatus(`Remove: ${name}`);
		const fadeOut = _state.pushNotification(element);
		update('Removing...', null);

		fetch(`${_state.config.basePath}/${encodeURIComponent(name)}`, { method: 'DELETE' })
			.then((resp) => {
				if (!resp.ok)
					return update(`Error: ${resp.statusText}`, false);

				/* remove the entry preemptively from the list */
				_state.updateList(_state.list.filter((entry) => entry.name != name));
				update(`Removed!`, true)
				fadeOut();
			})
			.catch(() => update('Network error', false));
	};
}

const UNIT_PREFIX_LIST = [[1_000_000_000_000_000, 'P'], [1_000_000_000_000, 'T'], [1_000_000_000, 'G'], [1_000_000, 'M'], [1_000, 'K'], [1, '']];
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
_state.updateList = (content) => {
	const host = document.getElementById('content');

	/* sort the content according to the presentation order */
	const compare = (a, b) => {
		if (a.kind != b.kind)
			return (a.kind == 'directory' ? -1 : 1);
		return (a.name < b.name ? -1 : (a.name == b.name ? 0 : 1));
	};
	content.sort(compare);

	/* iterate over the current list and content list, and synchronize them */
	let prev = 0, next = 0;
	while (true) {
		const hasPrev = (prev < _state.list.length), hasNext = (next < content.length);
		if (!hasPrev && !hasNext)
			break;
		const cmp = (hasNext ? (hasPrev ? compare(_state.list[prev], content[next]) : 1) : -1);

		/* check if an entry needs to be removed */
		if (cmp < 0) {
			host.removeChild(_state.list[prev].html);
			_state.list.splice(prev, 1);
			continue;
		}

		/* check if an entry needs to be added */
		if (cmp > 0) {
			const row = document.createElement('div');
			row.classList.add('row', 'button');

			const entry = document.createElement('a');
			entry.href = `./test`;
			entry.classList.add('entry');
			row.appendChild(entry);

			const icon = document.createElement('div');
			icon.classList.add('icon');
			icon.innerText = (content[next].kind == 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4');
			entry.appendChild(icon);

			const details = document.createElement('div');
			details.classList.add('details');
			entry.appendChild(details);

			const name = document.createElement('div');
			name.classList.add('name');
			name.innerText = content[next].name;
			details.appendChild(name);

			const info = document.createElement('div');
			info.classList.add('info');
			info.innerText = 'none';
			details.appendChild(info);

			const menu = document.createElement('div');
			menu.classList.add('button', 'option');
			menu.appendChild(_state.loadIcon('Menu', 'menu'));
			row.appendChild(menu);

			host.insertBefore(row, (hasPrev ? _state.list[prev].html : null));
			_state.list.splice(prev, 0, { kind: content[next].kind, name: content[next].name, html: row });
		}

		/* patch details up accordingly (must now exist in both lists, as either matched or newly created) */
		const entry = _state.list[prev], date = new Date(content[next].modified);
		const when = `${date.toLocaleTimeString()} ${date.toLocaleDateString()}`;
		if (content[next].kind == 'directory')
			entry.html.children[0].children[1].children[1].innerText = `${content[next].size} Items \u{2022} ${when}`;
		else
			entry.html.children[0].children[1].children[1].innerText = `${_state.formatSize(content[next].size)} \u{2022} ${when}`;

		/* patch the menu button and right click */
		entry.html.children[1].onclick = () => _state.showEntryMenu(entry.name);
		entry.html.oncontextmenu = (e) => {
			e.preventDefault();
			_state.showEntryMenu(entry.name);
		};
		++next, ++prev;
	}

	/* check if the list is empty and add the placeholder */
	document.getElementById('empty-directory').style.display = (_state.list.length == 0 ? 'block' : 'none');
	console.log('content list has been updated...');
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

	/* register the location listener to ensure the location is scroll end-favoring
	*	(to preserve the closer parents on small views; initialize for initial load) */
	const location = document.getElementById('location');
	let lastWidth = location.clientWidth;
	location.scrollLeft = location.scrollWidth - lastWidth;
	new ResizeObserver(() => {
		const width = location.clientWidth;
		if (width < lastWidth && location.scrollLeft + lastWidth >= location.scrollWidth)
			location.scrollLeft = location.scrollWidth - width;
		lastWidth = width;
	}).observe(location);

	/* setup the initial icons to be loaded */
	document.getElementById('icon-parent').appendChild(_state.loadIcon('Parent', 'back'));
	document.getElementById('icon-home').appendChild(_state.loadIcon('Home', 'home'));
	document.getElementById('icon-create').appendChild(_state.loadIcon('Create', 'create'));

	/* register the drag-and-drop handlers for the UI */
	if (_state.config.upload) {
		const dropDetector = document.getElementById('body');
		const dropZone = document.getElementById('drop-zone');
		let dropCountDepth = 0;
		dropDetector.ondragenter = (e) => {
			e.preventDefault();
			if (dropCountDepth++ == 0)
				dropZone.classList.add('expand');
		};
		dropDetector.ondragleave = (e) => {
			e.preventDefault();
			if (dropCountDepth > 0 && --dropCountDepth == 0)
				dropZone.classList.remove('expand');
		};
		dropDetector.ondragend = (e) => {
			dropCountDepth = 0;
			dropZone.classList.remove('expand');
		};
		dropDetector.ondragover = (e) => e.preventDefault();
		dropDetector.ondrop = (e) => {
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
		dropZone.style.setProperty('--animation-time', `${DROP_ZONE_ANIMATION}ms`);
		if (_state.config.maxUploadSize != null) {
			const text = `(Max. ${_state.formatSize(_state.config.maxUploadSize)})`;
			document.getElementById('drop-detail').innerHTML = text;
		}

		/* show and wire up the create button */
		document.getElementById('create-wrap').classList.remove('hidden');
		document.getElementById('create-button').onclick = () => _state.showMenu(null, [
			['Create Directory', () => console.log('Create!')],
			['Upload Files', () => {
				const input = document.createElement('input');
				input.type = 'file', input.multiple = true, input.onchange = () => {
					for (const file of input.files)
						_state.uploadFile(file, file.name, file.size);
					input.value = '';
				};
				input.click();
			}],
			['Upload Directory', () => {
				const input = document.createElement('input');
				input.type = 'file', input.webkitdirectory = true, input.onchange = () => {
					for (const file of input.files)
						_state.uploadFile(file, file.name, file.size);
					input.value = '';
				};
				input.click();
			}]
		]);
	}

	/* register all relevant delete overlay handler */
	const removeOverlay = document.getElementById('remove-overlay');
	removeOverlay.children[0].onmousedown = (e) => {
		e.stopPropagation();
	};
	removeOverlay.onmousedown = (e) => {
		e.preventDefault();
		_state.updateOverlay('remove-overlay', false);
	};
	document.getElementById('remove-abort').onclick = () => {
		_state.updateOverlay('remove-overlay', false);
	};

	/* register all relevant menu overlay handler */
	const menuOverlay = document.getElementById('menu-overlay');
	menuOverlay.children[0].onmousedown = (e) => {
		e.stopPropagation();
	};
	menuOverlay.onmousedown = (e) => {
		e.preventDefault();
		_state.updateOverlay('menu-overlay', false);
	};
	document.getElementById('menu-abort').onclick = () => {
		_state.updateOverlay('menu-overlay', false);
	};

	/* register convenience handlers for overlays */
	document.onkeydown = (e) => {
		if (e.key == 'Escape') {
			_state.updateOverlay('menu-overlay', false);
			_state.updateOverlay('remove-overlay', false);
		}
	};

	/* load the initial content list */
	const initList = [];
	for (const name in __LOAD_PARAMS__?.content ?? {})
		initList.push({ name, ...__LOAD_PARAMS__.content[name] });
	_state.updateList(initList);
}

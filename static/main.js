/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

const REMOVE_NOTIFICATION_ANIMATION = 25;
const FADE_NOTIFICATION_ANIMATION = 3500;
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
		], REMOVE_NOTIFICATION_ANIMATION);
		setTimeout(() => host.removeChild(entry), REMOVE_NOTIFICATION_ANIMATION);
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
		], FADE_NOTIFICATION_ANIMATION);
		setTimeout(() => close.onclick(), FADE_NOTIFICATION_ANIMATION);
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
	document.getElementById('remove-dialog').style.display = 'flex';

	document.getElementById('remove-confirm').onclick = () => {
		console.log(`removing [${name}]...`);
		document.getElementById('remove-dialog').style.display = 'none';

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
			const row = document.createElement('tr');
			row.classList.add('entry', 'button');

			const _icon = document.createElement('div');
			_icon.classList.add('icon');
			_icon.innerText = (content[next].kind == 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4');
			const icon = document.createElement('td');
			icon.appendChild(_icon);

			const _name = document.createElement('div');
			_name.classList.add('name');
			_name.innerText = content[next].name;
			const name = document.createElement('td');
			name.appendChild(_name);

			const _details = document.createElement('div');
			_details.classList.add('details');
			_details.innerText = 'none';
			const details = document.createElement('td');
			details.appendChild(_details);

			const _download = document.createElement('div');
			_download.classList.add('download', 'button', 'option');
			_download.appendChild(_state.loadIcon('Download', 'download'));
			const download = document.createElement('td');
			download.appendChild(_download);

			const remove = document.createElement('td');
			if (_state.config.delete) {
				const _remove = document.createElement('div');
				_remove.classList.add('delete', 'button', 'option');
				_remove.appendChild(_state.loadIcon('Delete', 'delete'));
				remove.appendChild(_remove);
			}

			row.appendChild(icon);
			row.appendChild(name);
			row.appendChild(details);
			row.appendChild(download);
			row.appendChild(remove);

			host.insertBefore(row, (hasPrev ? _state.list[prev].html : null));
			_state.list.splice(prev, 0, { kind: content[next].kind, name: content[next].name, html: row });
		}

		/* patch details up accordingly (must now exist in both lists, as either matched or newly created) */
		const entry = _state.list[prev];
		entry.size = content[next].size;
		if (content[next].kind == 'directory')
			entry.html.children[2].children[0].innerText = `${content[next].size} Items`;
		else
			entry.html.children[2].children[0].innerText = _state.formatSize(content[next].size);

		/* patch the remove button */
		if (_state.config.delete)
			entry.html.children[4].children[0].onclick = () => _state.removeFile(entry.name);
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

		/* patch the browse to file-input dialog flow */
		const fileInput = document.getElementById('file-input');
		document.getElementById('browse-files').onclick = () => fileInput.click();
		fileInput.onchange = () => {
			for (const file of fileInput.files)
				_state.uploadFile(file, file.name, file.size);
			fileInput.value = '';
		};

		/* actually present the drop content and add the size constraints */
		document.getElementById('upload-visual').style.display = 'flex';
		if (_state.config.maxUploadSize != null) {
			const text = `(Max. ${_state.formatSize(_state.config.maxUploadSize)})`;
			document.getElementById('drop-detail').innerHTML = text;
			document.getElementById('drop-visual-detail').innerHTML = text;
		}
	}

	/* register all relevant delete dialog handler */
	const removeDialog = document.getElementById('remove-dialog');
	removeDialog.children[0].onmousedown = (e) => {
		e.stopPropagation();
	};
	removeDialog.onmousedown = (e) => {
		e.preventDefault();
		removeDialog.style.display = 'none';
	};
	document.getElementById('remove-abort').onclick = () => {
		removeDialog.style.display = 'none';
	};

	/* load the initial content list */
	const initList = [];
	for (const name in __LOAD_PARAMS__?.content ?? {})
		initList.push({ name, ...__LOAD_PARAMS__.content[name] });
	_state.updateList(initList);
}

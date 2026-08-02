/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */

const REMOVE_NOTIFICATION_ANIMATION = 35;
const TRANSITION_OVERLAY_ANIMATION = 30;
const FADE_NOTIFICATION_ANIMATION = 3000;
const FILE_MAX_FAILURES = 12;
const FILE_OPERATION_BATCH_SIZE = 3;
const FILE_COPY_JOB_FIRST_POLL = 50;
const FILE_COPY_JOB_POLL_INTERVAL = 1000;
const FILE_COPY_JOB_PROGRESS_STEPS = 15;
const FILE_COPY_JOB_MAX_POLL_FAILURES = 3;
const DELAY_UNTIL_SPINNER = 150;
const DROP_ZONE_ANIMATION = 100;
const SOCKET_CONNECTION_RETRIES = 3;
const SOCKET_RECONNECT_TIMEOUT = 1000;
const VALID_NAME_REGEX = /^[^\x00-\x1f\x7f/\\\?:\*"<>\|]+$/;
const UNIT_PREFIX_LIST = [[1_000_000_000_000_000, 'P'], [1_000_000_000_000, 'T'], [1_000_000_000, 'G'], [1_000_000, 'M'], [1_000, 'K'], [1, '']];
const _state = { mouseLayout: false, selecting: false, viewStamp: 0, path: '', list: [], loadedIcons: {}, config: {}, overlay: {}, busy: 0, socket: { ws: null, count: 0, timer: null, message: null, hiddenAutoReconnect: false }, renaming: null };

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
function buildEncoded(path) {
	return path.split('/').map((val) => encodeURIComponent(val)).join('/');
}

_state.fs = {
	handleFetchResponse: async (response) => {
		if (response.status == 404)
			return 'Path not found';
		if (response.status == 413)
			return 'File is too large';
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
		try { response = await fetch(`${_state.encodeFilePath(path)}?raw=true&kind=directory`); }
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
	makeDirectory: async (path, silent, mtime) => {
		let response = null;

		/* try to create the new directory */
		const query = (mtime == null ? '' : `&mtime=${mtime}`);
		try { response = await fetch(`${_state.encodeFilePath(path)}?kind=directory&silent=${silent ? 'true' : 'false'}${query}`, { method: 'POST' }); }
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
		try { response = await fetch(`${_state.encodeFilePath(path)}?kind=${kind}`, { method: 'DELETE' }); }
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
		const baseUrl = `${_state.encodeFilePath(path)}?kind=file`;

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
		const id = response.headers.get('reservation-id');
		console.log(`Uploading file [${path}] with reservation [${id}]`);

		/* try to perform the actual upload request using the given reservation */
		const request = new XMLHttpRequest();
		request.open('POST', `${baseUrl}&reservation=${id}&mtime=${file.lastModified}`, true);
		request.upload.onprogress = (e) => {
			if (!settled)
				progress(file.size > 0 ? e.loaded / file.size : 1);
		}
		request.onload = () => {
			if (settled) return; settled = true;
			if (request.status < 200 || request.status >= 300)
				return reject(request.responseText ?? 'Unexpected server response');
			console.log(`File [${path}] uploaded`);
			resolve();
		};
		request.onerror = () => {
			if (settled) return; settled = true;
			reject('Network error');
		}
		request.send(file);
	}),
	move: async (path, target, kind) => {
		let response = null;

		/* try to move the object */
		try { response = await fetch(`${_state.encodeFilePath(path)}?kind=${kind}&move=${encodeURIComponent(target)}`, { method: 'PUT' }); }
		catch (_) {
			throw 'Network error';
		}

		/* validate the response */
		if (response.ok)
			console.log(`${kind == 'directory' ? 'Directory' : 'File'} [${path}] moved to [${target}]`);
		else
			throw await _state.fs.handleFetchResponse(response);
	},
	copy: async (path, target, progress) => {
		let response = null;

		/* try to start the copy operation */
		try { response = await fetch(`${_state.encodeFilePath(path)}?copy=${encodeURIComponent(target)}`, { method: 'PUT' }); }
		catch (_) {
			throw 'Network error';
		}

		/* validate the response */
		if (!response.ok)
			throw await _state.fs.handleFetchResponse(response);
		if (!response.headers.has('job-id'))
			throw 'Unexpected server response';
		const id = response.headers.get('job-id');
		console.log(`Copying file [${path}] to [${target}] as job [${id}]`);

		/* query the job status */
		await new Promise((resolve, reject) => {
			let failures = 0, jobStart = Date.now(), jobLastPoll = null, jobLastProgress = 0, lastUpdate = 0, stepTimer = null;
			const updateStatus = async () => {
				/* cancel any pending speculative step to prevent it from overlapping with the poll result */
				if (stepTimer != null)
					clearTimeout(stepTimer);
				stepTimer = null;

				let response = null, body = null;
				try { response = await fetch(buildPath(_state.config.jobs, id)); }
				catch (_) {
					/* tolerate transient network errors between polls, as the job
					*	keeps running on the server, and trigger the next check */
					if (++failures >= FILE_COPY_JOB_MAX_POLL_FAILURES)
						return reject('Network error');
					return setTimeout(() => updateStatus(), FILE_COPY_JOB_POLL_INTERVAL);
				}
				failures = 0;

				/* validate the json body result and parse it */
				if (!response.ok)
					return reject(await _state.fs.handleFetchResponse(response));
				if (response.headers.has('content-type') && !response.headers.get('content-type').startsWith('application/json'))
					return reject('Unexpected server response');
				try { body = await response.json(); }
				catch (_) {
					return reject('Malformed server response');
				}

				/* update the progress */
				if (body.state == 'failure')
					return reject(body.message);
				else if (body.state == 'success')
					return resolve();

				/* on the initial update, apply the progress, and then update it speculative based on the
				*	average of (totalProg / totalTime) and (lastProg / lastTime) up to the next poll */
				if (jobLastPoll == null)
					progress(lastUpdate = body.progress);
				const lastPoll = jobLastPoll ?? jobStart, lastProgress = jobLastProgress;
				jobLastPoll = Date.now(), jobLastProgress = Math.max(body.progress, jobLastProgress);
				const totalProgPerMS = (jobLastProgress / Math.max(1, jobLastPoll - jobStart));
				const lastProgPerMS = ((jobLastProgress - lastProgress) / Math.max(1, jobLastPoll - lastPoll));
				const forecast = Math.min(1.0, Math.max(lastUpdate, jobLastProgress + ((totalProgPerMS + lastProgPerMS) / 2) * FILE_COPY_JOB_POLL_INTERVAL));

				/* schedule the next poll independently of the speculative steps, to ensure throttled
				*	timers (such as in background tabs) do not stretch the actual poll interval */
				setTimeout(() => updateStatus(), FILE_COPY_JOB_POLL_INTERVAL);

				/* advance the progress towards the forecast every interval/N (the
				*	next poll will cancel any potentially still pending step) */
				const progressStep = (forecast - lastUpdate) / FILE_COPY_JOB_PROGRESS_STEPS;
				const nextStep = (index) => {
					if (index > 0)
						progress(lastUpdate += progressStep);
					if (index < FILE_COPY_JOB_PROGRESS_STEPS)
						stepTimer = setTimeout(() => nextStep(index + 1), FILE_COPY_JOB_POLL_INTERVAL / FILE_COPY_JOB_PROGRESS_STEPS);
				};
				nextStep(0);
			};

			/* trigger the initial job check (after a given wait time to
			*	give small copies the chance to resolve immediately) */
			setTimeout(() => updateStatus(), FILE_COPY_JOB_FIRST_POLL);
		});
	}
}
_state.batch = async (batch, task) => {
	/* check if this is the initial batch and initialize the state */
	if (batch.active == null)
		batch.active = 0, batch.waiting = null, batch.resolver = null;

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
_state.fullPath = (...paths) => {
	return buildPath(_state.path, ...paths);
}
_state.encodeFilePath = (path) => {
	return buildPath(_state.config.files, buildEncoded(path));
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
	/* check if this is the initial request and trigger the fetch (load the icons manually to ensure they are placed in-place
	*	and can be CSS modified, and are only fetched once, as re-fetches would otehrwise trigger repeated failure logs) */
	let promise = _state.loadedIcons[name] ?? null;
	if (promise == null) {
		promise = (_state.loadedIcons[name] = new Promise((resolve, reject) => {
			fetch(_state.config.icons[name] ?? '/bad_path').then((resp) => {
				if (!resp.ok)
					throw 0;
				return resp.text();
			}).then((content) => {
				try {
					const parser = new DOMParser();
					const icon = parser.parseFromString(content, 'image/svg+xml').documentElement;
					resolve(icon);
				}
				catch (_) {
					reject();
				}
			}).catch(() => reject());
		}));
	}

	/* setup the new element and attach the final icon insertion (on errors, insert the placeholder) */
	const element = buildElement({ class: 'load-icon' });
	promise.then((icon) => { element.replaceChildren(icon.cloneNode(true)); })
		.catch(() => { element.innerText = placeholder; });
	return element;
}
_state.makeLocation = (path, cb, links, selfDisable) => {
	const kind = (links ? 'a' : 'div');
	const location = buildElement({ class: 'wrapper location' });

	/* add the home button */
	const home = location.appendChild(buildElement({ kind, class: 'button icon', child: _state.loadIcon('Home', 'home') }));

	/* update the logic for home */
	if (path == '/' && selfDisable)
		home.classList.add('disabled');
	else {
		if (links)
			home.href = _state.encodeFilePath('/');
		home.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			cb('/');
		};
	}

	/* add the buttons for the path components */
	for (let i = 1, end = 0; i < path.length; i = end + 1) {
		end = path.indexOf('/', i);
		if (end < 0)
			end = path.length;

		location.appendChild(buildElement({ class: 'separator', text: '>' }));
		const entry = location.appendChild(buildElement({ kind, class: 'button text', text: path.substring(i, end) }));

		/* wire up the button logic */
		if (end >= path.length && selfDisable)
			entry.classList.add('disabled');
		else {
			if (links)
				entry.href = _state.encodeFilePath(path.substring(0, end));
			entry.onclick = (e) => {
				e.preventDefault();
				e.stopPropagation();
				cb(path.substring(0, end));
			};
		}
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
_state.pushRawNotification = (body) => {
	const host = document.getElementById('notifications');

	const entry = host.appendChild(buildElement({ class: 'entry' }));

	entry.appendChild(buildElement({ class: 'body', child: body }));
	const close = entry.appendChild(buildElement({ class: 'button', child: _state.loadIcon('Close', 'close') }));

	/* register the animated close handler and the phase-out handler */
	let faded = false, closed = false;
	close.onclick = (e) => {
		if (e != null)
			e.stopPropagation();
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
_state.pushMessage = () => {
	const upload = buildElement({ class: 'task' });

	/* create the actual notification and return the handler callback */
	const fadeOut = _state.pushRawNotification(upload);
	const barStartTime = Date.now();
	return (kind) => {
		/* check if the notification should be hidden */
		if (kind == null || typeof kind == 'boolean')
			return fadeOut(kind);

		/* check if a new text should be pushed */
		if (kind == 'text') {
			const element = upload.appendChild(buildElement({ class: 'text', text: '...' }));
			let t0 = '', t1 = '';
			return (text, detail) => {
				if (text == null && detail == null)
					return element.remove();
				if (text != null) t0 = text;
				if (detail != null) t1 = detail;
				element.innerText = t0 + (t1 == '' ? '' : ` (${t1})`);
			};
		}

		/* check if a new status should be pushed */
		if (kind == 'status') {
			const element = upload.appendChild(buildElement({ class: 'text status-base', text: '...' }));
			return (value, status) => {
				if (value == null && status == null)
					return element.remove();
				if (value != null)
					element.innerText = value;
				if (status != null)
					element.classList.add(status ? 'status-success' : 'status-failure');
			};
		}

		/* check if a new progress should be pushed */
		if (kind == 'progress') {
			const element = upload.appendChild(buildElement({ class: 'progress status-base' }));

			const text = element.appendChild(buildElement({ class: 'text', text: '...' }));
			const bar = element.appendChild(buildElement({ class: 'bar' }));
			const fill = bar.appendChild(buildElement({ class: 'fill uncertain' }));
			const digits = element.appendChild(buildElement({ class: 'digits', text: '--%' }));

			/* to ensure fast bar-swaps dont all repeatedly restart the uncertainty animation, ensure they
			*	all start at the same time to run synchronized, and overlay smoothly with previous bars */
			fill.style.animationDelay = `-${Date.now() - barStartTime}ms`;

			return (value, progress) => {
				if (value == null && progress == null)
					return element.remove();

				if (value != null)
					text.innerText = value;

				if (progress != null) {
					const value = `${Math.round(progress * 100)}%`;
					fill.classList.remove('uncertain');
					fill.style.width = value;
					digits.innerText = value;
				}
			};
		}

		/* check if a new button should be pushed */
		if (kind == 'button') {
			const element = upload.appendChild(buildElement({ class: 'clickable' }));
			const button = element.appendChild(buildElement({ class: 'button', text: '...' }));

			return (value, onclick) => {
				if (value == null && onclick == null)
					return element.remove();
				if (value != null)
					button.innerText = value;
				if (onclick != null) {
					button.onclick = (e) => {
						e.stopPropagation();
						onclick();
					};
				}
			};
		}
	};
}
_state.pushStaticTask = (caption, text, status) => {
	const message = _state.pushMessage();
	message('text')(caption);
	message('status')(text, status);
	if (status)
		message();
}
_state.pushStaticText = (text, status) => {
	const message = _state.pushMessage();
	message('status')(text, status);
	if (status)
		message();
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
	let hidden = false;
	for (const name of ['menu', 'pick', 'remove']) {
		if (name != skip && _state.updateOverlay(`${name}-overlay`, null))
			hidden = true;
	}
	return hidden;
}
_state.updateOverlay = (name, notify) => {
	const overlay = document.getElementById(name);

	/* hide all other overlays */
	if (notify != null)
		_state.hideOverlays(name);

	/* check if the overlay is already hidden */
	else if (!(name in _state.overlay))
		return false;

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
	return true;
}
_state.showEntriesMenu = (entries) => {
	if (entries.length == 0) return;
	const single = (entries.length == 1 ? entries[0] : null);

	let menuSize = 1;
	if (single != null)
		menuSize += 1;
	if (_state.config.upload)
		menuSize += 1;
	if (_state.config.delete)
		menuSize += 1;
	if (_state.config.upload && _state.config.delete)
		menuSize += (single != null ? 2 : 1);
	if (single != null && navigator?.clipboard != null)
		++menuSize;

	/* initialize the menu caption and list size */
	const content = document.getElementById('menu-content');
	document.getElementById('menu-caption').classList.remove('hidden');
	document.getElementById('menu-name').innerText = (single?.name ?? `${entries.length} Objects Selected`);
	_state.updateMenuLength(content, menuSize);

	/* helper method to ensure the entry is still valid */
	let settled = false, entryIndex = 0;
	const validateEntries = (checkSettled) => {
		if (checkSettled && settled) return false;

		/* check if any of the entires has been removed */
		let dropped = 0, droppedName = '';
		for (const entry of entries) {
			if (_state.list.indexOf(entry) >= 0)
				continue;
			++dropped, droppedName = entry.name;
		}
		if (dropped == 0)
			return true;

		if (dropped == 1)
			_state.pushStaticText(`'${droppedName}' does not exist anymore`, false);
		else
			_state.pushStaticText(`${dropped} objects do not exist anymore`, false);

		if (!settled)
			_state.updateOverlay('menu-overlay', null);
		return false;
	};

	/* register the common menu options */
	if (single != null) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Open', 'open'));
		content.children[entryIndex].children[1].innerText = 'Open';
		content.children[entryIndex++].onclick = (e) => {
			e.stopPropagation();
			if (!validateEntries(true)) return;

			const path = _state.fullPath(single.name);
			if (single.kind == 'directory')
				_state.setupContentView(path, null, false);
			else
				document.location = _state.encodeFilePath(path);
		};
	}
	content.children[entryIndex].children[0].appendChild(_state.loadIcon('Download', 'download'));
	content.children[entryIndex].children[1].innerText = 'Download';
	content.children[entryIndex++].onclick = (e) => {
		e.stopPropagation();
		if (!validateEntries(true)) return;
		_state.updateOverlay('menu-overlay', null);

		/* request the actual download of the content */
		for (const entry of entries) {
			const download = document.createElement('a');
			download.href = `${_state.encodeFilePath(_state.fullPath(entry.name))}?kind=${entry.kind}&download=true`;
			download.download = '';
			download.click();
		}
	};

	/* register the copy-url interaction */
	if (single != null && navigator?.clipboard != null) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Clipboard', 'clipboard'));
		content.children[entryIndex].children[1].innerText = 'Copy URL';
		content.children[entryIndex++].onclick = (e) => {
			e.stopPropagation();
			if (!validateEntries(true)) return;

			_state.updateOverlay('menu-overlay', null);
			navigator.clipboard.writeText(new URL(_state.encodeFilePath(_state.fullPath(single.name)), document.location).href)
				.then(() => _state.pushStaticText('Copied to clipboard!', true))
				.catch(() => _state.pushStaticText('Failed writing to clipboard', false));
		};
	}

	/* register the modification interactions */
	if (single != null && _state.config.upload && _state.config.delete) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Rename', 'rename'));
		content.children[entryIndex].children[1].innerText = 'Rename';
		content.children[entryIndex++].onclick = (e) => {
			e.stopPropagation();
			if (!validateEntries(true)) return;
			_state.updateOverlay('menu-overlay', null);

			/* start renaming the element */
			_state.renameAnyEntry(single.html.name, () => validateEntries(false), async (fileName) => {
				single.html.name.innerText = single.name;
				if (fileName == null || fileName == single.name)
					return;
				const message = _state.pushMessage();
				message('text')(`Rename '${single.name}' to '${fileName}'`);
				const update = message('status');
				update('Renaming...');

				/* try to perform the actual move */
				try {
					await _state.fs.move(_state.fullPath(single.name), _state.fullPath(fileName), single.kind);
					update('Successfully renamed!', true);
					message();

					/* apply the update preemtively to the list (ensure that a new list is created) */
					_state.updateList(_state.list.filter((e) => e != single).concat([{ name: fileName, kind: single.kind, size: single.size, modified: single.modified }]));
				}
				catch (e) { update(e, false); }
			});
		};
	}
	if (_state.config.upload) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Copy', 'copy'));
		content.children[entryIndex].children[1].innerText = 'Copy to...';
		content.children[entryIndex++].onclick = (e) => {
			e.stopPropagation();
			if (!validateEntries(true)) return;
			_state.updateOverlay('menu-overlay', null);
			_state.showMoveCopyPicker(false, single, (path) => {
				if (!validateEntries(false)) return;

				if (path != _state.path)
					return _state.copyContent(___entry, buildPath(path, ___entry.name), path);
				if (single == null) return;

				/* find the temporary name to be used */
				const dot = single.name.lastIndexOf('.');
				const baseName = (single.name.substring(0, dot < 0 ? single.name.length : dot)), extName = (dot < 0 ? '' : single.name.substring(dot));
				let tempName = '';
				for (let i = 1; ; ++i) {
					tempName = `${baseName} - Copy${i > 1 ? ` (${i})` : ''}${extName}`;
					if (_state.list.findIndex((v) => v.name == tempName) < 0)
						break;
				}

				/* for an in-place copy, create a new temporary entry to be renamed */
				const fakeEntry = _state.createListEntry({ name: tempName, kind: single.kind }, false);
				const host = document.getElementById('content');
				host.insertBefore(fakeEntry.html.row, host.children[0]);
				fakeEntry.html.row.scrollIntoView();

				/* start editing the new element */
				_state.renameAnyEntry(fakeEntry.html.name, () => true, (fileName) => {
					fakeEntry.html.row.remove();
					if (fileName != null && validateEntries(false))
						_state.copyContent(single, _state.fullPath(fileName), fileName);
				});
			});
		};
	}
	if (_state.config.upload && _state.config.delete) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Move', 'move'));
		content.children[entryIndex].children[1].innerText = 'Move to...';
		content.children[entryIndex++].onclick = (e) => {
			e.stopPropagation();
			if (!validateEntries(true)) return;
			_state.updateOverlay('menu-overlay', null);
			_state.showMoveCopyPicker(true, false, async (path) => {
				if (!validateEntries(false)) return;

				const message = _state.pushMessage();
				message('text')(`Move '${___entry.name}' to '${path}'`);
				const update = message('status');
				update('Moving...');

				/* try to perform the actual move */
				try {
					await _state.fs.move(_state.fullPath(___entry.name), buildPath(path, ___entry.name), ___entry.kind);
					update('Successfully moved!', true);
					message();

					/* apply the update preemtively to the list (ensure that a new list is created) */
					_state.updateList(_state.list.filter((e) => e != ___entry));
				}
				catch (e) { update(e, false); }
			});
		};
	}

	/* register the delete interaction */
	if (_state.config.delete) {
		content.children[entryIndex].children[0].appendChild(_state.loadIcon('Delete', 'delete'));
		content.children[entryIndex].children[1].innerText = 'Delete';
		content.children[entryIndex].classList.add('delete');
		content.children[entryIndex++].onclick = (e) => {
			e.stopPropagation();
			if (!validateEntries(true)) return;
			_state.updateOverlay('menu-overlay', null);

			/* ask the user if the deletion should actually be performed */
			_state.showDeleteConfirm(single == null ? entries.map((v) => v.name).join('\n') : _state.fullPath(single.name), () => {
				if (validateEntries(false))
					_state.removeContent(entries);
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
	if (_state.config.uploadLimit != 0) {
		const text = `Max. ${_state.formatSize(_state.config.uploadLimit)} per file`;
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
		_state.uploadContent(list, (directory ? 'selected directory' : 'selected files'));
	};
	content.children[0].onclick = (e) => {
		e.stopPropagation();
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		/* create the new fake list to be edited */
		const entry = _state.createListEntry({ name: '', kind: 'directory' }, false);
		const host = document.getElementById('content');
		host.insertBefore(entry.html.row, host.children[0]);
		entry.html.row.scrollIntoView();

		/* start editing the new element */
		_state.createDirectory(entry.html.name, _state.path, (promise) => {
			entry.html.row.remove();
		});
	};
	content.children[1].onclick = (e) => {
		e.stopPropagation();
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		const input = document.createElement('input');
		input.type = 'file';
		input.multiple = true;
		input.onchange = () => processInputFiles(input, false);
		input.click();
	};
	content.children[2].onclick = (e) => {
		e.stopPropagation();
		if (settled) return;
		_state.updateOverlay('menu-overlay', null);

		const input = document.createElement('input');
		input.type = 'file';
		input.webkitdirectory = true;
		input.onchange = () => processInputFiles(input, true);
		input.click();
	};
}
_state.showMoveCopyPicker = (move, self, callback) => {
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
	const fetched = { [_state.path]: baseList.sort() };

	/* setup helper functions for the dialog */
	let settled = false, busyTimer = null, cancelTask = () => { }, batchState = {};
	const markAsBusy = () => {
		if (busyTimer != null) return;
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
		_state.batch(batchState, () => {
			if (settled) return Promise.resolve();
			return _state.fs.fetchDirectory(target);
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
			clearBusy();
			_state.pushStaticTask(`Enumerating '${target}' error`, e, false);
		});
	};
	const updateView = (path) => {
		const directories = fetched[path];

		/* update the confirmation button (clear the handler while disabled) */
		const disabled = (path == _state.path && !self);
		if (disabled)
			confirm.classList.add('disabled');
		else
			confirm.classList.remove('disabled');
		confirm.onclick = (disabled ? null : (e) => {
			e.stopPropagation();
			if (settled) return;
			_state.updateOverlay('pick-overlay', null);
			callback(path);
		});

		/* construct the actual entries */
		_state.updateMenuLength(content, directories.length);
		for (let i = 0; i < directories.length; ++i) {
			content.children[i].children[0].appendChild(_state.loadIcon('Directory', 'directory'));
			content.children[i].children[1].classList.add('path');
			content.children[i].children[1].innerText = directories[i];
			content.children[i].onclick = (e) => {
				e.stopPropagation();
				navigateDirectories(buildPath(path, directories[i]));
			};
		}

		/* update the navigation and add the create-button */
		navigation.replaceChild(_state.makeLocation(path, (target) => navigateDirectories(target), false, true), navigation.children[0]);
		navigation.children[1].onclick = (e) => {
			e.stopPropagation();
			cancelTask();
			if (settled || busyTimer != null)
				return;

			/* create the temporary fake entry to be used for the renaming */
			const fakeEntry = content.insertBefore(_state.createMenuEntry(), content.children[0] ?? null);
			fakeEntry.children[0].appendChild(_state.loadIcon('Directory', 'directory'));
			fakeEntry.children[1].classList.add('path');
			fakeEntry.scrollIntoView();

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
				}).catch(() => {
					if (settled) return;
					clearBusy();
				});
			});
		};
	};

	/* construct the initial list and show the actual menu */
	updateView(_state.path);
	_state.updateOverlay('pick-overlay', () => {
		settled = true;
		cancelTask();
		clearBusy();
	});
}
_state.showDeleteConfirm = (message, callback) => {
	document.getElementById('remove-name').innerText = message;

	let settled = false;
	document.getElementById('remove-confirm').onclick = (e) => {
		e.stopPropagation();
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

		if (_state.renaming?.element == element) {
			document.getElementById('body').classList.remove('disable-buttons');
			_state.renaming = null;
		}
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
		_state.pushStaticText(`'${fileName}' is not a valid name (No: \\ / ? : * " < > | )`, false);
		return cleanupRename(null);
	};
	const updateOperation = (confirm) => {
		if (!checkOperation()) return;
		if (confirm)
			confirmRename();
		else
			cleanupRename(null);
	};

	/* check if the document is not focused, and the rename should just be ignored/silently discarded */
	if (!document.hasFocus()) {
		console.log(`Ignoring renaming [${element.innerText}] as the document is not focused`);
		return cleanupRename(null);
	}

	/* temporarily start editing the single element and hide any button effects */
	_state.renaming = { element, click: () => updateOperation(true) };
	document.getElementById('body').classList.add('disable-buttons');
	element.contentEditable = true;
	element.focus({ preventScroll: true });
	element.onblur = () => updateOperation(true);

	/* select the entire content of the element */
	const selection = window.getSelection(), range = document.createRange();
	range.selectNodeContents(element);
	selection.removeAllRanges();
	selection.addRange(range);

	/* register the abort handler */
	element.onkeydown = (e) => {
		if (e.key != 'Escape' && e.key != 'Enter') return;
		if (!checkOperation()) return;
		e.stopPropagation();
		e.preventDefault();
		if (e.key == 'Escape')
			cleanupRename(null);
		else
			confirmRename();
	};

	/* return the abort callback */
	return () => updateOperation(false);
}
_state.createListEntry = (params, makeAsLink) => {
	const row = buildElement({ class: 'row button' });

	/* check if the entry should be created as navigation entry */
	const entry = row.appendChild(buildElement({ kind: (makeAsLink ? 'a' : 'div'), class: 'entry' }));
	if (makeAsLink)
		entry.href = _state.encodeFilePath(_state.fullPath(params.name));

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
	const menu = buildElement({ class: 'button option', child: _state.loadIcon('Menu', 'menu') });
	const side = row.appendChild(buildElement({ class: 'side', child: menu }));

	return { ...params, selected: false, html: { row, link: entry, name, size, date, side, menu } };
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

		/* check if an entry needs to be removed (remove from list before removing from tree to ensure 'onblur' can detect the removal) */
		if (cmp < 0) {
			const row = _state.list.splice(prev, 1)[0].html.row;
			host.removeChild(row);
			continue;
		}

		/* check if an entry needs to be added (link and name will still match) */
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
		++next, ++prev;

		/* patch details up accordingly (must now exist in both lists, as either matched or newly created) */
		if (entry.kind == 'directory')
			entry.html.size.innerText = `${entry.size} Items`;
		else
			entry.html.size.innerText = `${_state.formatSize(entry.size)}`;
		const date = new Date(entry.modified);
		entry.html.date.innerText = `${date.toLocaleTimeString()} ${date.toLocaleDateString()}`;

		/* patch up the menu button (not affected by different layouts) */
		entry.html.menu.onclick = (e) => {
			e.stopPropagation();
			if (!_state.selecting)
				_state.showEntriesMenu([entry]);
		};

		/* patch the click and right click (only internally redirect clicks for directories) */
		entry.html.link.onclick = (e) => {
			if (!_state.mouseLayout && _state.selecting) {
				entry.selected = !entry.selected;
				_state.updateSelection(false);
			}
			else if (entry.kind == 'directory')
				_state.setupContentView(_state.fullPath(entry.name), null, false);
			else
				return;
			e.preventDefault();
			e.stopPropagation();
		};
		entry.html.row.oncontextmenu = (e) => {
			e.preventDefault();
			e.stopPropagation();
			if (_state.mouseLayout)
				_state.showEntriesMenu([entry]);
			else {
				entry.selected = !entry.selected;
				_state.updateSelection(false);
			}
		};
	}
	console.log(`content list has been updated to ${_state.list.length} entries...`);
	_state.updateSelection(false);
}
_state.updateSelection = (clear) => {
	let count = 0;

	/* either clear the selection or count the number of selected entries and update the selection style */
	for (const entry of _state.list) {
		if (clear) entry.selected = false;
		if (entry.selected) {
			++count;
			entry.html.row.classList.add('selected');
		}
		else
			entry.html.row.classList.remove('selected');
	}

	/* check if this is considered a mutli-selection, in which case the single-menus need to be hidden */
	_state.selecting = (count > (_state.mouseLayout ? 1 : 0));
	if (_state.selecting)
		document.getElementById('content').classList.add('multi-selected');
	else
		document.getElementById('content').classList.remove('multi-selected');

	/* check if the menu button needs to be shown */
	if (_state.selecting)
		document.getElementById('top-menu-button').classList.remove('hidden');
	else
		document.getElementById('top-menu-button').classList.add('hidden');

	/* hide the create-menu buttons */
	if (_state.selecting) {
		document.getElementById('top-create-button').classList.add('selecting');
		document.getElementById('fab-create-button').classList.add('selecting');
	}
	else {
		document.getElementById('top-create-button').classList.remove('selecting');
		document.getElementById('fab-create-button').classList.remove('selecting');
	}
}

_state.createDirectory = (element, path, callback) => {
	if (!_state.config.upload) {
		_state.pushStaticText('Not allowed to upload content', false);
		callback(null);
		return () => { };
	}

	element.innerText = 'New Directory';
	return _state.renameAnyEntry(element, () => true, (fileName) => {
		if (fileName == null)
			return callback(null);

		const fullPath = buildPath(path, fileName);
		callback(new Promise((resolve, reject) => {
			const message = _state.pushMessage();
			message('text')(`Create '${path == _state.path ? fileName : fullPath}'`);
			const update = message('status');
			update('Creating...');

			_state.fs.makeDirectory(fullPath, false, null)
				.then(() => {
					update('Directory created!', true);
					message();

					/* check if it should also be pushed to the root list (ensure that a new list is created) */
					if (_state.path == path && _state.list.findIndex((v) => v.name == fileName) < 0)
						_state.updateList(_state.list.concat([{ name: fileName, kind: 'directory', size: 0, modified: Date.now() }]));
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
	const basePath = _state.path;

	/* mark the state as busy */
	++_state.busy;

	/* setup the notification */
	const message = _state.pushMessage();
	const caption = message('text');
	caption(`Upload ${what}`);

	/* collect the list of all uploads to be performed */
	const totalList = [], directories = {};
	const fetchDirectory = (path) => {
		/* the root is always considered valid */
		if (path.length <= 1)
			return null;
		if (path in directories)
			return directories[path];
		const parent = path.substring(0, path.lastIndexOf('/'));

		/* check if its an entry in the current list, which is implicitly considered to exist (silently ignore errors) */
		if (parent == '') {
			const next = path.substring(1);
			const index = _state.list.findIndex((e) => e.name == next);
			if (index >= 0 && _state.list[index].kind == 'directory')
				return (directories[path] = null);
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
		const promises = [];
		for (const child of await entry.children())
			promises.push(unpackEntry(child));
		await Promise.all(promises);
	};

	const initPromises = [], update = message('status');
	update('Calculating...');
	for (const entry of list)
		initPromises.push(unpackEntry(entry));
	await Promise.all(initPromises);

	update();
	caption(null, `0/${totalList.length}`);

	/* helper functions to perform uploads */
	const uploadFile = async (file) => {
		const update = message('progress');
		update(file.path.substring(1));

		/* check if the file is too large */
		if (_state.config.uploadLimit != 0 && file.size > _state.config.uploadLimit) {
			_state.pushStaticTask(`Upload '${file.path.substring(1)}'`, `Skipping too large file (${_state.formatSize(file.size)} > ${_state.formatSize(_state.config.uploadLimit)})`, false);
			update();
			return false;
		}

		/* try to perform the actual upload */
		let success = false, progressed = false;
		try {
			await _state.fs.upload(buildPath(basePath, file.path), (p) => {
				if ((p <= 0 || p >= 1) && !progressed) return;
				progressed = true;
				update(null, p);
			}, file.file);
			success = true;

			/* add the entry preemtively to the list (ensure that a new list is created) */
			const name = file.path.substring(file.path.lastIndexOf('/') + 1);
			if (file.path == _state.fullPath(name) && _state.list.findIndex((v) => v.name == name) < 0)
				_state.updateList(_state.list.concat([{ name, kind: 'file', size: file.size, modified: file.file.lastModified }]));
		}
		catch (e) {
			_state.pushStaticTask(`Upload '${file.path.substring(1)}'`, e, false);
		}

		update();
		return success;
	};
	const uploadDirectory = async (path) => {
		const update = message('status');
		update(path.substring(1));

		/* try to create the new directory */
		let success = false;
		try {
			await _state.fs.makeDirectory(buildPath(basePath, path), true, null);
			success = true;

			/* check if this is a root directory and preemtively add the entry to the list (ensure that a new list is created) */
			const name = path.substring(path.lastIndexOf('/') + 1);
			if (path == _state.fullPath(name) && _state.list.findIndex((v) => v.name == name) < 0)
				_state.updateList(_state.list.concat([{ name, kind: 'directory', size: 0, modified: Date.now() }]));
		}
		catch (e) {
			_state.pushStaticTask(`Upload '${path.substring(1)}'`, e, false);
		}

		update();
		return success;
	};

	/* iterate over the list and collect the uploads */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0, batchState = {};
	for (const entry of totalList) {
		entry.promise = (async () => {
			let success = false;

			/* await the parent (before batching to ensure it does not consume a batch-slot) */
			let failedParent = (entry.parent != null && !await totalList[entry.parent].promise);
			if (totalFailed > FILE_MAX_FAILURES)
				return false;

			/* batch the actual operation (to limit the number of parallel operations) */
			return _state.batch(batchState, async () => {
				if (failedParent) {
					if (totalFailed > FILE_MAX_FAILURES)
						return false;
					++totalSkipped;
				}

				/* perform the actual upload, unless the operation has already failed, in which
				*	case nothing more will be performed (i.e. just silently skip the task) */
				else if (totalFailed > FILE_MAX_FAILURES)
					return false;
				else {
					let result = false;
					if (entry.kind == 'file')
						result = await uploadFile(entry);
					else
						result = await uploadDirectory(entry.path);

					/* apply the result to the overall counters */
					if (!result)
						++totalFailed;
					else
						success = true;
				}

				/* update the overall task counter (also for skipped tasks, to ensure it always completes) */
				caption(null, `${++totalPerformed}/${totalList.length}`);
				return success;
			});
		})();
		promises.push(entry.promise);
	}
	await Promise.all(promises);

	/* clear the busy state */
	--_state.busy;

	/* log the final status message */
	if (totalPerformed < totalList.length)
		message('status')(`Aborted due to too many failed uploads (Failed: ${totalFailed})`, false);
	else if (totalFailed > 0)
		message('status')(`Failed to upload ${totalFailed} entries${totalSkipped > 0 ? ` (Skipped: ${totalSkipped})` : ''}`, false);
	else {
		message('status')('Successfully uploaded!', true);
		message();
	}

	/* check if all entries failed, in which case the host message does not have any benefit of existing */
	if (totalFailed == totalList.length)
		message(true);
}
_state.removeContent = async (entries) => {
	if (!_state.config.delete)
		return _state.pushStaticText('Not allowed to delete content', false);
	if (entries.length == 0) return;
	for (const entry of entries)
		console.log(`Removing [${_state.fullPath(entry.name)}]...`);
	const basePath = _state.path;

	/* mark the state as busy */
	++_state.busy;

	/* setup the notification */
	const message = _state.pushMessage();
	const caption = message('text');
	caption(`Remove ${entries.length == 1 ? `'${entries[0].name}'` : `${entries.length} objects`}`);

	/* initialization helper methods */
	const totalList = [], batchState = {}, calcUpdate = message('status'), initPromises = [];
	let initFailed = false;
	const fetchAndUpdate = async (path) => {
		if (initFailed) return;

		/* fetch the content list */
		let content = null;
		try { content = await _state.batch(batchState, () => _state.fs.fetchDirectory(buildPath(basePath, path))); }
		catch (e) {
			if (!initFailed)
				calcUpdate(`Enumerating '${path.substring(1)}' error: ${e}`, false);
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

	/* recursively collect the list of all files and directories to be removed */
	calcUpdate('Calculating...');
	for (const entry of entries) {
		if (entry.kind == 'file')
			totalList.push({ path: `/${entry.name}`, kind: 'file' });
		else
			initPromises.push(fetchAndUpdate(`/${entry.name}`));
	}

	/* await the initialization and check if it failed */
	await Promise.all(initPromises);
	if (initFailed) {
		--_state.busy;
		return;
	}
	calcUpdate();
	caption(null, `0/${totalList.length}`);

	/* iterate over the list and collect the deletions */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		entry.promise = (async () => {
			let success = false;

			/* await the children (before batching to ensure it does not consume a batch-slot) */
			let childrenValid = true;
			if (entry.kind == 'directory') {
				for (const index of entry.children)
					childrenValid = (childrenValid && await totalList[index].promise);
			}
			if (totalFailed > FILE_MAX_FAILURES)
				return false;

			/* batch the actual operation (to limit the number of parallel operations) */
			return _state.batch(batchState, async () => {
				if (!childrenValid) {
					if (totalFailed > FILE_MAX_FAILURES)
						return false;
					++totalSkipped;
				}

				/* perform the actual deletion, unless the operation has already failed, in which
				*	case nothing more will be performed (i.e. just silently skip the task) */
				else if (totalFailed > FILE_MAX_FAILURES)
					return false;
				else {
					const update = message('status');
					update(entry.path.substring(1));

					try {
						await _state.fs.remove(buildPath(basePath, entry.path), entry.kind);
						success = true;
					}
					catch (e) {
						_state.pushStaticTask(`Remove '${entry.path.substring(1)}'`, e, false);
						++totalFailed;
					}
					update();
				}

				/* update the overall task counter (also for skipped tasks, to ensure it always completes) */
				caption(null, `${++totalPerformed}/${totalList.length}`);
				return success;
			});
		})();
		promises.push(entry.promise);
	}
	await Promise.all(promises);

	/* clear the busy state */
	--_state.busy;

	/* log the final message and optionally preemtively remove the entry from the list (ensure that a new list is created; skipped can only be > 0, if failed is > 0) */
	if (totalPerformed < totalList.length)
		message('status')(`Aborted due to too many failed deletions (Failed: ${totalFailed})`, false);
	else if (totalFailed > 0)
		message('status')(`Failed to delete ${totalFailed} entries${totalSkipped > 0 ? ` (Skipped: ${totalSkipped})` : ''}`, false);
	else {
		if (_state.path == basePath)
			_state.updateList(_state.list.filter((value) => !entries.some((e) => value.name == e.name)));
		message('status')('Successfully removed!', true);
		message();
	}

	/* check if all entries failed, in which case the host message does not have any benefit of existing */
	if (totalFailed == totalList.length)
		message(true);
}
_state.copyContent = async (entry, target, printTarget) => {
	if (!_state.config.upload)
		return _state.pushStaticText('Not allowed to upload content', false);
	console.log(`Copying [${_state.fullPath(entry.name)}] to [${target}]...`);
	const basePath = _state.path;

	/* mark the state as busy */
	++_state.busy;

	/* setup the notification */
	const message = _state.pushMessage();
	const caption = message('text');
	caption(`Copy '${entry.name}' to '${printTarget}'`);

	/* recursively collect the list of all files and directories to be copied */
	const totalList = [], batchState = {};
	if (entry.kind == 'directory') {
		const update = message('status');
		update('Calculating...');

		let initFailed = false;
		const fetchAndUpdate = async (src, dst, parent, modified) => {
			if (initFailed) return;

			/* write the directory to the list */
			const index = totalList.length;
			totalList.push({ src, dst, kind: 'directory', parent, modified, size: 0 });

			/* fetch the content list */
			let content = null;
			try { content = await _state.batch(batchState, () => _state.fs.fetchDirectory(buildPath(basePath, src))); }
			catch (e) {
				if (!initFailed)
					update(`Enumerating '${src.substring(1)}' error: ${e}`, false);
				initFailed = true;
				return;
			}
			if (initFailed) return;

			/* recursively visit all children and process them (after the parent to ensure it is already in the list) */
			const promises = [];
			for (const name in content) {
				if (initFailed) return;

				const childSrc = buildPath(src, name);
				const childDst = buildPath(dst, name);
				if (content[name].kind == 'file')
					totalList.push({ src: childSrc, dst: childDst, kind: 'file', size: content[name].size, modified: content[name].modified, parent: index });
				else
					promises.push(fetchAndUpdate(childSrc, childDst, index, content[name].modified));
			}
			await Promise.all(promises);
		};
		await fetchAndUpdate(`/${entry.name}`, target, null, entry.modified);

		if (initFailed) {
			--_state.busy;
			return;
		}
		update();
	}
	else
		totalList.push({ src: `/${entry.name}`, dst: target, kind: 'file', size: entry.size, modified: entry.modified, parent: null });
	caption(null, `0/${totalList.length}`);

	/* helper functions to perform copying */
	const copyFile = async (fileSize, src, dst, modified) => {
		const update = message('progress');
		update(src.substring(1));

		/* check if the file is too large */
		if (_state.config.uploadLimit != 0 && fileSize > _state.config.uploadLimit) {
			_state.pushStaticTask(`Copy '${src.substring(1)}'`, `Skipping too large file (${_state.formatSize(fileSize)} > ${_state.formatSize(_state.config.uploadLimit)})`, false);
			update();
			return false;
		}

		/* try to perform the actual copy */
		let success = false, progressed = false;
		try {
			await _state.fs.copy(buildPath(basePath, src), dst, (p) => {
				if ((p <= 0 || p >= 1) && !progressed) return;
				progressed = true;
				update(null, p);
			});
			success = true;

			/* add the entry preemtively to the list (ensure that a new list is created; the
			*	copy preserves the modified-time of the source) */
			const name = dst.substring(dst.lastIndexOf('/') + 1);
			if (dst == _state.fullPath(name) && _state.list.findIndex((v) => v.name == name) < 0)
				_state.updateList(_state.list.concat([{ name, kind: 'file', size: fileSize, modified }]));
		}
		catch (e) {
			_state.pushStaticTask(`Copy '${src.substring(1)}'`, e, false);
		}

		update();
		return success;
	};
	const copyDirectory = async (src, dst, modified) => {
		const update = message('status');
		update(src.substring(1));

		/* try to create/copy the new directory (not silent, must succeed) */
		let success = false;
		try {
			await _state.fs.makeDirectory(dst, false, modified);
			success = true;

			/* check if this is a root directory and preemtively add the entry to the list (ensure that a new list is created) */
			const name = dst.substring(dst.lastIndexOf('/') + 1);
			if (dst == _state.fullPath(name) && _state.list.findIndex((v) => v.name == name) < 0)
				_state.updateList(_state.list.concat([{ name, kind: 'directory', size: 0, modified }]));
		}
		catch (e) {
			_state.pushStaticTask(`Copy '${src.substring(1)}'`, e, false);
		}

		update();
		return success;
	};

	/* iterate over the list and collect the copying */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		entry.promise = (async () => {
			let success = false;

			/* await the parent (before batching to ensure it does not consume a batch-slot) */
			let failedParent = (entry.parent != null && !await totalList[entry.parent].promise);
			if (totalFailed > FILE_MAX_FAILURES)
				return false;

			/* batch the actual operation (to limit the number of parallel operations) */
			return _state.batch(batchState, async () => {
				if (failedParent) {
					if (totalFailed > FILE_MAX_FAILURES)
						return false;
					++totalSkipped;
				}

				/* perform the actual copy, unless the operation has already failed, in which
				*	case nothing more will be performed (i.e. just silently skip the task) */
				else if (totalFailed > FILE_MAX_FAILURES)
					return false;
				else {
					let result = false;
					if (entry.kind == 'file')
						result = await copyFile(entry.size, entry.src, entry.dst, entry.modified);
					else
						result = await copyDirectory(entry.src, entry.dst, entry.modified);

					/* apply the result to the overall counters */
					if (!result)
						++totalFailed;
					else
						success = true;
				}

				/* update the overall task counter (also for skipped tasks, to ensure it always completes) */
				caption(null, `${++totalPerformed}/${totalList.length}`);
				return success;
			});
		})();
		promises.push(entry.promise);
	}
	await Promise.all(promises);

	/* clear the busy state */
	--_state.busy;

	/* log the final status message */
	if (totalPerformed < totalList.length)
		message('status')(`Aborted due to too many failed copies (Failed: ${totalFailed})`, false);
	else if (totalFailed > 0)
		message('status')(`Failed to copy ${totalFailed} entries${totalSkipped > 0 ? ` (Skipped: ${totalSkipped})` : ''}`, false);
	else {
		message('status')('Successfully copied!', true);
		message();
	}

	/* check if all entries failed, in which case the host message does not have any benefit of existing */
	if (totalFailed == totalList.length)
		message(true);
}
_state.setupSocket = (initial) => {
	/* close the previous socket and reset the backoff timers and state */
	if (_state.socket.ws != null)
		_state.socket.ws.close();
	if (_state.socket.message != null)
		_state.socket.message(true);
	if (_state.socket.timer != null)
		clearTimeout(_state.socket.timer);

	/* reset the socket state */
	_state.socket.ws = null;
	_state.socket.message = null;
	_state.socket.timer = null;
	_state.socket.hiddenAutoReconnect = false;

	/* register the auto-recover callbacks to ensure the socket is reconnected once the page is brought to visibility */
	document.onvisibilitychange = () => {
		if (!document.hidden && _state.socket.hiddenAutoReconnect)
			_state.setupSocket(false);
	};

	/* reconnection handler */
	const tryReconnect = () => {
		if (_state.socket.ws == null) {
			_state.socket.count = SOCKET_CONNECTION_RETRIES;
			_state.setupSocket(false);
		}
	};

	/* try to setup the new socket */
	const path = buildPath(_state.config.sockets, buildEncoded(_state.path));
	const self = new WebSocket(`${location.protocol == 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
	_state.socket.ws = self;
	++_state.socket.count;
	console.log(`Connecting to listen for changes on [${self.url}]...`);

	/* register the socket callback */
	self.onopen = () => {
		if (_state.socket.ws != self) return;
		console.log('Connection established');
		_state.socket.count = 0;

		/* perform a fetch to ensure the list is up-to-date (not on the
		*	initial sync; assume it to be valid; silently ignore errors) */
		if (initial) return;
		_state.socket.fetching = true;
		_state.fs.fetchDirectory(_state.path)
			.then((content) => {
				const list = [];
				for (const name in content)
					list.push({ name, ...content[name] });
				_state.updateList(list);
			})
			.catch((e) => console.log(`Failed to fetch directory content: ${e}`));
	};
	self.onmessage = (m) => {
		if (_state.socket.ws != self) return;

		/* check if its a status message (all of them result in the connection being closed) */
		if (m.data == 'removed' || m.data == 'error' || m.data == 'close') {
			console.log(`Message received: ${m.data}`);
			_state.socket.ws = null;
			self.close();

			/* check if the directory has been removed (clear the list afterwards to indicate the removal) */
			_state.socket.message = _state.pushMessage();
			if (m.data == 'removed') {
				_state.socket.message('text')('The current directory has been removed!');
				_state.updateList([]);
			}

			else if (m.data == 'error')
				_state.socket.message('status')('Listening for changes: Internal error on server', false);
			else
				_state.socket.message('text')('Listening for changes: The server has shut down');

			_state.socket.message('button')('Try to Reconnect', tryReconnect);
			return;
		}

		/* parse the new server state and update the list */
		try {
			console.log('List update received');

			const list = [], content = JSON.parse(m.data);
			for (const name in content)
				list.push({ name, ...content[name] });
			_state.updateList(list);
		} catch (err) {
			console.log(`Error parsing server update message: ${err.message}`);
			_state.socket.ws = null;
			self.close();

			_state.socket.message = _state.pushMessage();
			_state.socket.message('status')('Listening for changes: Malformed update', false);
			_state.socket.message('button')('Reconnect', tryReconnect);
		}
	};
	self.onclose = () => {
		if (_state.socket.ws != self) return;
		console.log('Connection to remote side lost');
		_state.socket.ws = null;

		/* check if the page is hidden, in which case the error can silently
		*	be ignored (the change to visible will silently reconnect it) */
		if (document.hidden) {
			_state.socket.hiddenAutoReconnect = true;
			return;
		}

		/* notify the user about the lost connection */
		_state.socket.message = _state.pushMessage();
		_state.socket.message('status')('Listening for changes: Connection lost', false);
		_state.socket.message('button')('Try to Reconnect', tryReconnect);
	};
	self.onerror = () => {
		if (_state.socket.ws != self) return;
		console.log(`Socket connection error`);
		_state.socket.ws = null;

		/* check if the page is hidden, in which case the error can silently
		*	be ignored (the change to visible will silently reconnect it) */
		if (document.hidden) {
			_state.socket.hiddenAutoReconnect = true;
			return;
		}

		/* check if the connection should be re-tried */
		if (_state.socket.count < SOCKET_CONNECTION_RETRIES)
			return _state.socket.timer = setTimeout(() => _state.setupSocket(false), SOCKET_RECONNECT_TIMEOUT);
		_state.socket.message = _state.pushMessage();
		_state.socket.message('status')('Listening for changes: Network error', false);
		_state.socket.message('button')('Retry', tryReconnect);
	};
}
_state.setupPageContext = (update) => {
	/* update the history to contain the newly visited page */
	const thisPathUrl = `${window.location.protocol}//${window.location.host}${_state.encodeFilePath(_state.path)}`;
	if (update)
		window.history.replaceState(_state.path, '', thisPathUrl);
	else
		window.history.pushState(_state.path, '', thisPathUrl);

	/* update the page title */
	document.title = (_state.path == '/' ? 'Root Directory' : `Directory: ${_state.path.substring(_state.path.lastIndexOf('/') + 1)}`);
}
_state.setupContentView = async (path, content, update) => {
	/* always update title, as history-navigations might otherwise sometimes get confused */
	console.log(`Navigating from [${_state.path}] to [${path}]`);
	if (_state.path == path)
		return _state.setupPageContext(true);

	/* allocate the next view stamp and hide the overlays and clear the selection */
	const viewStamp = ++_state.viewStamp;
	_state.hideOverlays();
	_state.updateSelection(true);

	/* check if the new state needs to be fetched and await its results */
	let busyView = document.getElementById('content-busy'), fetchError = null;
	if (content == null) {
		const busyTimer = setTimeout(() => {
			if (viewStamp == _state.viewStamp)
				busyView.classList.remove('hidden');
		}, DELAY_UNTIL_SPINNER);

		/* fetch the new content and cache any errors for proper handling */
		try { content = await _state.fs.fetchDirectory(path); }
		catch (e) { fetchError = e; }

		/* clear the timeout, in case it has not yet fired */
		clearTimeout(busyTimer);
	}

	/* check if the state is still in-order to be applied and reset the visual state */
	if (viewStamp != _state.viewStamp)
		return;
	busyView.classList.add('hidden');
	if (_state.path == path)
		return _state.setupPageContext(true);
	_state.hideOverlays();
	_state.updateSelection(true);

	/* check if the path failed to be opened, and the previous path should be kept, and
	*	otherwise setup the new path and update the history (even in error cases) */
	if (fetchError == null)
		_state.path = path;
	else
		_state.pushStaticTask(`Opening '${path}' error`, fetchError, false);
	_state.setupPageContext(update || fetchError);
	if (fetchError != null)
		return;

	/* update the state list */
	const itemList = [];
	for (const name in content)
		itemList.push({ name, ...content[name] });
	_state.updateList(itemList);

	/* setup the top navigation references and location view */
	const navigation = document.getElementById('navigation'), parent = document.getElementById('button-parent');
	navigation.replaceChild(_state.makeLocation(_state.path, (path) => _state.setupContentView(path, null, false), true, false), navigation.children[1]);
	if (_state.path == '/') {
		parent.classList.add('disabled');
		delete parent.href;
		parent.onclick = null;
	}
	else {
		let parentPath = _state.path.substring(0, _state.path.lastIndexOf('/'));
		if (parentPath == '')
			parentPath = '/';

		parent.classList.remove('disabled');
		parent.href = _state.encodeFilePath(parentPath);
		parent.onclick = (e) => {
			e.preventDefault();
			e.stopPropagation();
			_state.setupContentView(parentPath, null, false);
		};
	}

	/* connect the socket to listen for changes */
	_state.setupSocket(true);
}
_state.setupLayout = (mouse) => {
	console.log(`Configuring layout to: ${mouse ? 'mouse' : 'touch'}`);
	_state.mouseLayout = mouse;

	/* toggle the visibility of the create buttons */
	if (_state.config.upload) {
		if (mouse) {
			document.getElementById('fab-create-button').classList.add('hidden');
			document.getElementById('top-create-button').classList.remove('hidden');
		}
		else {
			document.getElementById('fab-create-button').classList.remove('hidden');
			document.getElementById('top-create-button').classList.add('hidden');
		}
	}

	/* update the selection (as it differs based on the mode) */
	_state.updateSelection(false);
}

window.onload = () => {
	const mainBody = document.getElementById('body');

	/* parse the initial configuration */
	_state.config.delete = (__LOAD_PARAMS__?.delete ?? false);
	_state.config.upload = (__LOAD_PARAMS__?.upload ?? false);
	_state.config.uploadLimit = (__LOAD_PARAMS__?.uploadLimit ?? 0);
	_state.config.files = (__LOAD_PARAMS__?.files ?? '/bad_path');
	_state.config.jobs = (__LOAD_PARAMS__?.jobs ?? '/bad_path');
	_state.config.sockets = (__LOAD_PARAMS__?.sockets ?? '/bad_path');
	_state.config.icons = (__LOAD_PARAMS__?.icons ?? {});

	/* register the busy alert */
	window.onbeforeunload = (e) => {
		if (_state.busy == 0)
			return null;
		e.preventDefault();
		return "keep";
	};

	/* register page moving detection */
	window.addEventListener('popstate', (e) => {
		if (typeof e.state == 'string')
			_state.setupContentView(e.state, null, true);
		else {
			_state.setupContentView('/', null, false);
			_state.pushStaticText('Error returning to previous state', false);
		}
	});

	/* setup the initial icons to be loaded, pre-load the close icon (is always used for notifications), and make the initial empty location */
	document.getElementById('button-parent').appendChild(_state.loadIcon('Parent', 'back'));
	document.getElementById('create-fab').appendChild(_state.loadIcon('Create', 'create'));
	document.getElementById('create-top').appendChild(_state.loadIcon('Create', 'create'));
	document.getElementById('menu-top').appendChild(_state.loadIcon('Menu', 'menu'));
	document.getElementById('pick-create').appendChild(_state.loadIcon('Create', 'create'));
	const navigation = document.getElementById('navigation');
	navigation.replaceChild(_state.makeLocation('/', () => { }, false, false), navigation.children[1]);
	_state.loadIcon('Preload', 'close').remove();

	/* register the drag-and-drop handlers for the UI */
	if (_state.config.upload) {
		const dropDetector = mainBody, dropZone = document.getElementById('drop-zone');
		let dropCountDepth = 0;

		dropDetector.ondragenter = (e) => {
			if (e.dataTransfer?.types?.includes('Files') !== true) return;
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
			if (e.dataTransfer?.types?.includes('Files') !== true) return;
			e.preventDefault();
		}
		dropDetector.ondrop = (e) => {
			if (e.dataTransfer?.types?.includes('Files') !== true) return;
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
						_state.pushStaticText(`Error processing dropped file '${path}'`, false);
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
							_state.pushStaticText(`Error processing children of dropped directory '${path}'`, false);
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
				_state.uploadContent(list, 'dropped content');
			})();
		};

		/* update the drop animations and add the size constraints */
		dropZone.style.setProperty('--drop-zone-animations', `${DROP_ZONE_ANIMATION}ms`);
		if (_state.config.uploadLimit != 0)
			document.getElementById('drop-detail').innerText = `(Max. ${_state.formatSize(_state.config.uploadLimit)})`;

		/* wire up the create buttons */
		document.getElementById('create-fab').onclick = (e) => {
			e.stopPropagation();
			_state.showCreateMenu();
		};
		document.getElementById('create-top').onclick = (e) => {
			e.stopPropagation();
			_state.showCreateMenu();
		};
	}

	/* register all mouse capture events for renaming (to prevent clicks from triggering any
	*	side-effects; clicks, which originate on the renamed entry, will not be forwarded) */
	lClickSource = null;
	mainBody.addEventListener('mousedown', (e) => {
		if (_state.renaming == null) return;
		if (_state.renaming.element.contains(e.target)) {
			if (e.button == 0) lClickSource = _state.renaming;
		} else {
			if (e.button == 0) lClickSource = null;
			e.preventDefault();
			e.stopPropagation();
		}
	}, true);
	mainBody.addEventListener('click', (e) => {
		if (_state.renaming == null) return;
		e.stopPropagation();
		e.preventDefault();
		if (lClickSource != _state.renaming)
			_state.renaming.click();
		lClickSource = null;
	}, true);
	mainBody.addEventListener('contextmenu', (e) => {
		if (_state.renaming != null)
			e.stopPropagation();
	}, true);

	/* register all relevant overlay key handler (to ensure mouse-events are not passed to children) */
	for (const name of ['remove', 'menu', 'pick']) {
		const overlay = document.getElementById(`${name}-overlay`);
		overlay.children[0].onmousedown = (e) => e.stopPropagation();
		overlay.onclick = (e) => e.stopPropagation();
		overlay.onmousedown = (e) => {
			e.stopPropagation();
			e.preventDefault();
			_state.updateOverlay(`${name}-overlay`, null);
		};
		document.getElementById(`${name}-abort`).onclick = (e) => {
			e.stopPropagation();
			_state.updateOverlay(`${name}-overlay`, null);
		};
	}

	/* register convenience handlers for overlays and selection-clearing */
	document.addEventListener('keydown', (e) => {
		if (e.key != 'Escape') return;
		e.stopPropagation();
		e.preventDefault();
		if (!_state.hideOverlays())
			_state.updateSelection(true);
		e.target.blur();
	});
	let clickTarget = null;
	mainBody.addEventListener('mousedown', (e) => {
		clickTarget = (e.button == 0 ? e.target : null);
	});
	mainBody.addEventListener('mouseup', (e) => {
		if (e.button != 0 || e.target != clickTarget)
			clickTarget = null;
	});
	mainBody.addEventListener('click', (e) => {
		if (!_state.selecting || e.target != clickTarget) return;
		if (clickTarget.dataset.clearselection != 'true') return;
		clickTarget = null;
		e.stopPropagation();
		e.preventDefault();
		_state.updateSelection(true);
	});

	/* register the multi-menu button handler */
	document.getElementById('top-menu-button').onclick = (e) => {
		e.stopPropagation();
		if (!_state.selecting) return;

		/* collect the selected entries and show the entry menu */
		const entries = [];
		for (const entry of _state.list) {
			if (entry.selected)
				entries.push(entry);
		}
		_state.showEntriesMenu(entries);
	};

	/* register the layout change detection and configure the initial layout */
	const layoutListener = matchMedia('(pointer: fine) and (hover: hover)');
	layoutListener.onchange = () => _state.setupLayout(layoutListener.matches);
	_state.setupLayout(layoutListener.matches);

	/* setup the initial content view */
	_state.setupContentView((__LOAD_PARAMS__?.path ?? '/'), (__LOAD_PARAMS__?.content ?? null), true);
}

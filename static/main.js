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
const VALID_NAME_REGEX = /^[^\x00-\x1f\x7f/\\\?:\*"<>\|]+$/;
const UNIT_PREFIX_LIST = [[1_000_000_000_000_000, 'P'], [1_000_000_000_000, 'T'], [1_000_000_000, 'G'], [1_000_000, 'M'], [1_000, 'K'], [1, '']];
const _state = { list: [], fakeEntries: 0, loadedIcons: {}, config: {}, overlay: {}, batchState: { active: 0, waiting: null, resolver: null }, busy: 0 };

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
		try { response = await fetch(`${_state.encodePath(path)}?raw=true&kind=directory`); }
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
		try { response = await fetch(`${_state.encodePath(path)}?kind=directory&silent=${silent ? 'true' : 'false'}${query}`, { method: 'POST' }); }
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
		try { response = await fetch(`${_state.encodePath(path)}?kind=${kind}`, { method: 'DELETE' }); }
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
		const baseUrl = `${_state.encodePath(path)}?kind=file`;

		/* try to reserve the given path (to test if its valid/available, before writing data to it) */
		let response = null, settled = false;
		try { response = await fetch(`${baseUrl}&reserve=true&mtime=${file.lastModified}`, { method: 'POST' }); }
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
		request.open('POST', `${baseUrl}&reservation=${id}`, true);
		request.upload.onprogress = (e) => {
			if (!settled)
				progress(file.size > 0 ? e.loaded / file.size : 1);
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
	}),
	move: async (path, target, kind) => {
		let response = null;

		/* try to move the object */
		try { response = await fetch(`${_state.encodePath(path)}?kind=${kind}&move=${encodeURIComponent(target)}`, { method: 'PUT' }); }
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
		try { response = await fetch(`${_state.encodePath(path)}?copy=${encodeURIComponent(target)}`, { method: 'PUT' }); }
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
_state.fullPath = (...paths) => {
	return buildPath(_state.config.path, ...paths);
}
_state.encodePath = (path) => {
	let out = _state.config.files;

	for (let i = (path.startsWith('/') ? 1 : 0); i < path.length;) {
		let end = path.indexOf('/', i);
		if (end < 0)
			end = path.length;

		out = buildPath(out, encodeURIComponent(path.substring(i, end)));
		i = end + 1;
	}
	return out;
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
_state.makeLocation = (path, cb) => {
	const kind = (cb == null ? 'a' : 'div');
	const location = buildElement({ class: 'wrapper location' });

	/* add the home button */
	const home = location.appendChild(buildElement({ kind, class: 'button icon', child: _state.loadIcon('Home', 'home') }));

	/* update the logic for home */
	if (cb == null)
		home.href = _state.encodePath('/');
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
			entry.href = _state.encodePath(path.substring(0, end));
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
_state.pushRawNotification = (body) => {
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
_state.pushMessage = () => {
	const upload = buildElement({ class: 'task' });

	/* create the actual notification and return the handler callback */
	const fadeOut = _state.pushRawNotification(upload);
	const barTimeStarts = [];
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

			/* to ensure overlayed bars, which repeatedly end up at the same position dont constantly restart their animation time, use
			*	the last start time at the given index as base time for the animation, hence just picking the uncertain animation back up */
			let startTime = Date.now();
			if (barTimeStarts.length >= upload.children.length && barTimeStarts[upload.children.length - 1] != null) {
				fill.style.animationDelay = `-${startTime - barTimeStarts[upload.children.length - 1]}ms`;
				startTime = barTimeStarts[upload.children.length - 1];
			}

			return (value, progress) => {
				if (value == null && progress == null) {
					/* lookup the entries slot in the current message body and check if it has already been dropped */
					let index = 0;
					while (index < upload.children.length && upload.children[index] != element)
						++index;
					if (index >= upload.children.length)
						return;

					/* write back the current animation delay start time */
					while (barTimeStarts.length <= index)
						barTimeStarts.push(null);
					barTimeStarts[index] = startTime;
					return element.remove();
				}

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
		_state.pushStaticText(`'${entry.name}' does not exist anymore`, false);
		if (!settled)
			_state.updateOverlay('menu-overlay', null);
		return false;
	};

	/* register the common menu options */
	content.children[0].children[0].appendChild(_state.loadIcon('Open', 'open'));
	content.children[0].children[1].innerText = 'Open';
	content.children[0].onclick = () => {
		if (validateEntry(true))
			document.location = _state.encodePath(_state.fullPath(entry.name));
	};
	content.children[1].children[0].appendChild(_state.loadIcon('Download', 'download'));
	content.children[1].children[1].innerText = 'Download';
	content.children[1].onclick = () => {
		if (!validateEntry(true)) return;
		_state.updateOverlay('menu-overlay', null);

		/* request the actual download of the content */
		const download = document.createElement('a');
		download.href = `${_state.encodePath(_state.fullPath(entry.name))}?kind=${entry.kind}&download=true`;
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
			navigator.clipboard.writeText(new URL(_state.encodePath(_state.fullPath(entry.name)), document.location).href)
				.then(() => _state.pushStaticText('Copied to clipboard!', true))
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
			_state.renameAnyEntry(entry.html.name, () => validateEntry(false), async (fileName) => {
				entry.html.name.innerText = entry.name;
				if (fileName == null || fileName == entry.name)
					return;
				const message = _state.pushMessage();
				message('text')(`Rename '${entry.name}' to '${fileName}'`);
				const update = message('status');
				update('Renaming...');

				/* try to perform the actual move */
				try {
					await _state.fs.move(_state.fullPath(entry.name), _state.fullPath(fileName), entry.kind);
					update('Successfully renamed!', true);
					message();

					/* apply the update preemtively to the list (ensure that a new list is created) */
					_state.updateList(_state.list.filter((e) => e != entry).concat([{ name: fileName, kind: entry.kind, size: entry.size, modified: entry.modified }]));
				}
				catch (e) { update(e, false); }
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
				if (path != _state.config.path)
					return _state.copyContent(entry, buildPath(path, entry.name), path);

				/* find the temporary name to be used */
				const dot = entry.name.lastIndexOf('.');
				const baseName = (entry.name.substring(0, dot < 0 ? entry.name.length : dot)), extName = (dot < 0 ? '' : entry.name.substring(dot));
				let tempName = '';
				for (let i = 1; ; ++i) {
					tempName = `${baseName} - Copy${i > 1 ? ` (${i})` : ''}${extName}`;
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
						_state.copyContent(entry, _state.fullPath(fileName), fileName);
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
			_state.showMoveCopyPicker(true, async (path) => {
				if (!validateEntry(false))
					return;
				const message = _state.pushMessage();
				message('text')(`Move '${entry.name}' to '${path}'`);
				const update = message('status');
				update('Moving...');

				/* try to perform the actual move */
				try {
					await _state.fs.move(_state.fullPath(entry.name), buildPath(path, entry.name), entry.kind);
					update('Successfully moved!', true);
					message();

					/* apply the update preemtively to the list (ensure that a new list is created) */
					_state.updateList(_state.list.filter((e) => e != entry));
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
		content.children[entryIndex++].onclick = () => {
			if (!validateEntry(true)) return;
			_state.updateOverlay('menu-overlay', null);

			/* ask the user if the deletion should actually be performed */
			_state.showDeleteConfirm(entry.name, () => {
				if (validateEntry(false))
					_state.removeContent(entry);
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
		_state.uploadContent(list, (directory ? 'selected directory' : 'selected files'));
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
		_state.createDirectory(entry.html.name, _state.config.path, (promise) => {
			entry.html.row.remove();
			--_state.fakeEntries;
			_state.updateList(null);
			if (promise == null) return;

			/* add the entry preemtively to the list (ensure that a new list is created) */
			promise.then((fileName) => {
				if (_state.list.findIndex((v) => v.name == fileName) < 0)
					_state.updateList(_state.list.concat([{ name: fileName, kind: 'directory', size: 0, modified: Date.now() }]));
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
	const fetched = { [_state.config.path]: baseList.sort() };

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
			_state.pushStaticTask(`Enumerating '${target}' error`, e, false);
			_state.updateOverlay('pick-overlay', null);
		});
	};
	const updateView = (path) => {
		const directories = fetched[path];

		/* update the confirmation button (clear the handler while disabled) */
		const disabled = (move && path == _state.config.path);
		if (disabled)
			confirm.classList.add('disabled');
		else
			confirm.classList.remove('disabled');
		confirm.onclick = (disabled ? null : () => {
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
					if (path == _state.config.path && _state.list.findIndex((v) => v.name == fileName) < 0)
						_state.updateList(_state.list.concat([{ name: fileName, kind: 'directory', size: 0, modified: Date.now() }]));
				}).catch(() => {
					if (settled) return;
					clearBusy();
				});
			});
		};
	};

	/* construct the initial list and show the actual menu */
	updateView(_state.config.path);
	_state.updateOverlay('pick-overlay', () => {
		settled = true;
		cancelTask();
		clearBusy();
	});
}
_state.showDeleteConfirm = (name, callback) => {
	document.getElementById('remove-name').innerText = _state.fullPath(name);

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
		_state.pushStaticText(`'${fileName}' is not a valid name (No: \\ / ? : * " < > | )`, false);
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
		entry.href = _state.encodePath(_state.fullPath(params.name));

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
		const date = new Date(content[next].modified);
		entry.html.date.innerText = `${date.toLocaleTimeString()} ${date.toLocaleDateString()}`;

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
			message('text')(`Create '${path == _state.config.path ? fileName : fullPath}'`);
			const update = message('status');
			update('Creating...');

			_state.batch(() => _state.fs.makeDirectory(fullPath, false, null))
				.then(() => {
					update('Directory created!', true);
					message();
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

		/* check if the file is too large (does not contribute to the total-failed counter) */
		if (_state.config.maxUploadSize != null && file.size > _state.config.maxUploadSize) {
			_state.pushStaticTask(`Upload '${file.path.substring(1)}'`, `Skipping too large file (${_state.formatSize(file.size)} > ${_state.formatSize(_state.config.maxUploadSize)})`, false);
			update();
			return null;
		}

		/* try to perform the actual upload */
		let success = false, progressed = false;
		try {
			await _state.fs.upload(_state.fullPath(file.path), (p) => {
				if ((p <= 0 || p >= 1) && !progressed) return;
				progressed = true;
				update(null, p);
			}, file.file);
			success = true;

			/* add the entry preemtively to the list (ensure that a new list is created) */
			const name = file.path.substring(file.path.lastIndexOf('/') + 1);
			if (file.path.length == name.length + 1)
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
			await _state.fs.makeDirectory(_state.fullPath(path), true, null);
			success = true;

			/* check if this is a root directory and preemtively add the entry to the list (ensure that a new list is created) */
			const name = path.substring(path.lastIndexOf('/') + 1);
			if (path.length == name.length + 1)
				_state.updateList(_state.list.concat([{ name, kind: 'directory', size: 0, modified: Date.now() }]));
		}
		catch (e) {
			_state.pushStaticTask(`Upload '${path.substring(1)}'`, e, false);
		}

		update();
		return success;
	};

	/* iterate over the list and collect the uploads (shared batching across all remote operations) */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		entry.promise = _state.batch(async () => {
			let success = false;

			/* check if the entry has a parent, which failed (mark the object as
			*	skipped; not if the operation as a whole has already failed) */
			if (entry.parent != null && !await totalList[entry.parent].promise) {
				if (totalFailed > FILE_MAX_FAILURES)
					return false;
				++totalSkipped;
			}

			/* perform the actual upload, unless the operation has already failed, in which
			*	case nothing more will be performed (i.e. just silently skip the task) */
			else if (totalFailed > FILE_MAX_FAILURES)
				return false;
			else {
				let result = null;
				if (entry.kind == 'file')
					result = await uploadFile(entry);
				else
					result = await uploadDirectory(entry.path);

				/* apply the result to the overall counters (null implies a silently skipped task) */
				if (result == null)
					++totalSkipped;
				else if (!result)
					++totalFailed;
				else
					success = true;
			}

			/* update the overall task counter (also for skipped tasks, to ensure it always completes) */
			caption(null, `${++totalPerformed}/${totalList.length}`);
			return success;
		});
		promises.push(entry.promise);
	}
	await Promise.all(promises);

	/* clear the busy state */
	--_state.busy;

	/* log the final status message */
	if (totalFailed > FILE_MAX_FAILURES)
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
_state.removeContent = async (entry) => {
	if (!_state.config.delete)
		return _state.pushStaticText('Not allowed to delete content', false);
	console.log(`Removing [${_state.fullPath(entry.name)}]...`);

	/* mark the state as busy */
	++_state.busy;

	/* setup the notification */
	const message = _state.pushMessage();
	const caption = message('text');
	caption(`Remove '${entry.name}'`);

	/* recursively collect the list of all files and directories to be removed */
	const totalList = [];
	if (entry.kind == 'directory') {
		const update = message('status');
		update('Calculating...');

		let initFailed = false;
		const fetchAndUpdate = async (path) => {
			if (initFailed) return;

			/* fetch the content list */
			let content = null;
			try { content = await _state.batch(() => _state.fs.fetchDirectory(_state.fullPath(path))); }
			catch (e) {
				if (!initFailed)
					update(`Enumerating '${path.substring(1)}' error: ${e}`, false);
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
		await fetchAndUpdate(`/${entry.name}`);

		if (initFailed) {
			--_state.busy;
			return;
		}
		update();
	}
	else
		totalList.push({ path: `/${entry.name}`, kind: 'file' });
	caption(null, `0/${totalList.length}`);

	/* iterate over the list and collect the deletions (shared batching across all remote operations) */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		entry.promise = _state.batch(async () => {
			const update = message('status');
			update(entry.path.substring(1));
			let success = false, childrenValid = true;

			/* check if this is a directory with children, which failed to be removed (mark
			*	the object as skipped; not if the operation as a whole has already failed) */
			if (entry.kind == 'directory') {
				for (const index of entry.children)
					childrenValid = (childrenValid && await totalList[index].promise);
			}
			if (!childrenValid) {
				if (totalFailed > FILE_MAX_FAILURES) {
					update();
					return false;
				}
				++totalSkipped;
			}

			/* perform the actual deletion, unless the operation has already failed, in which
			*	case nothing more will be performed (i.e. just silently skip the task) */
			else if (totalFailed > FILE_MAX_FAILURES) {
				update();
				return false;
			}
			else {
				try {
					await _state.fs.remove(_state.fullPath(entry.path), entry.kind);
					success = true;
				}
				catch (e) {
					_state.pushStaticTask(`Remove '${entry.path.substring(1)}'`, e, false);
					++totalFailed;
				}
			}

			/* update the overall task counter (also for skipped tasks, to ensure it always completes) */
			update();
			caption(null, `${++totalPerformed}/${totalList.length}`);
			return success;
		});
		promises.push(entry.promise);
	}
	await Promise.all(promises);

	/* clear the busy state */
	--_state.busy;

	/* log the final message and optionally preemtively remove the entry from the list (ensure that a new list is created; skipped can only be > 0, if failed is > 0) */
	if (totalFailed > FILE_MAX_FAILURES)
		message('status')(`Aborted due to too many failed deletions (Failed: ${totalFailed})`, false);
	else if (totalFailed > 0)
		message('status')(`Failed to delete ${totalFailed} entries${totalSkipped > 0 ? ` (Skipped: ${totalSkipped})` : ''}`, false);
	else {
		_state.updateList(_state.list.filter((value) => value.name != entry.name));
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

	/* mark the state as busy */
	++_state.busy;

	/* setup the notification */
	const message = _state.pushMessage();
	const caption = message('text');
	caption(`Copy '${entry.name}' to '${printTarget}'`);

	/* recursively collect the list of all files and directories to be copied */
	const totalList = [];
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
			try { content = await _state.batch(() => _state.fs.fetchDirectory(_state.fullPath(src))); }
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

		/* check if the file is too large (does not contribute to the total-failed counter) */
		if (_state.config.maxUploadSize != null && fileSize > _state.config.maxUploadSize) {
			_state.pushStaticTask(`Copy '${src.substring(1)}'`, `Skipping too large file (${_state.formatSize(fileSize)} > ${_state.formatSize(_state.config.maxUploadSize)})`, false);
			update();
			return null;
		}

		/* try to perform the actual copy */
		let success = false, progressed = false;
		try {
			await _state.fs.copy(_state.fullPath(src), dst, (p) => {
				if ((p <= 0 || p >= 1) && !progressed) return;
				progressed = true;
				update(null, p);
			});
			success = true;

			/* add the entry preemtively to the list (ensure that a new list is created; the
			*	copy preserves the modified-time of the source) */
			const name = dst.substring(dst.lastIndexOf('/') + 1);
			if (dst == _state.fullPath(name))
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
			if (dst == _state.fullPath(name))
				_state.updateList(_state.list.concat([{ name, kind: 'directory', size: 0, modified }]));
		}
		catch (e) {
			_state.pushStaticTask(`Copy '${src.substring(1)}'`, e, false);
		}

		update();
		return success;
	};

	/* iterate over the list and collect the copying (shared batching across all remote operations) */
	let promises = [], totalFailed = 0, totalSkipped = 0, totalPerformed = 0;
	for (const entry of totalList) {
		entry.promise = _state.batch(async () => {
			let success = false;

			/* check if the entry has a parent, which failed (mark the object as
			*	skipped; not if the operation as a whole has already failed) */
			if (entry.parent != null && !await totalList[entry.parent].promise) {
				if (totalFailed > FILE_MAX_FAILURES)
					return false;
				++totalSkipped;
			}

			/* perform the actual copy, unless the operation has already failed, in which
			*	case nothing more will be performed (i.e. just silently skip the task) */
			else if (totalFailed > FILE_MAX_FAILURES)
				return false;
			else {
				let result = null;
				if (entry.kind == 'file')
					result = await copyFile(entry.size, entry.src, entry.dst, entry.modified);
				else
					result = await copyDirectory(entry.src, entry.dst, entry.modified);

				/* apply the result to the overall counters (null implies a silently skipped task) */
				if (result == null)
					++totalSkipped;
				else if (!result)
					++totalFailed;
				else
					success = true;
			}

			/* update the overall task counter (also for skipped tasks, to ensure it always completes) */
			caption(null, `${++totalPerformed}/${totalList.length}`);
			return success;
		});
		promises.push(entry.promise);
	}
	await Promise.all(promises);

	/* clear the busy state */
	--_state.busy;

	/* log the final status message */
	if (totalFailed > FILE_MAX_FAILURES)
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

window.onload = () => {
	/* parse the initial configuration */
	_state.config.delete = (__LOAD_PARAMS__?.delete ?? false);
	_state.config.upload = (__LOAD_PARAMS__?.upload ?? false);
	_state.config.maxUploadSize = (_state.config.upload ? (__LOAD_PARAMS__?.maxUploadSize ?? null) : 0);
	if (_state.config.maxUploadSize != null && _state.config.maxUploadSize <= 0)
		_state.config.upload = false;
	_state.config.path = (__LOAD_PARAMS__?.path ?? '/');
	_state.config.files = (__LOAD_PARAMS__?.files ?? '/bad_path');
	_state.config.jobs = (__LOAD_PARAMS__?.jobs ?? '/bad_path');
	_state.config.sockets = (__LOAD_PARAMS__?.sockets ?? '/bad_path');
	_state.config.icons = (__LOAD_PARAMS__?.icons ?? {});

	/* register the busy alert */
	window.onbeforeunload = function (e) {
		if (_state.busy == 0)
			return null;
		e.preventDefault();
		return "keep";
	};

	/* setup the initial icons to be loaded */
	document.getElementById('button-parent').appendChild(_state.loadIcon('Parent', 'back'));
	document.getElementById('create-button').appendChild(_state.loadIcon('Create', 'create'));
	document.getElementById('pick-create').appendChild(_state.loadIcon('Create', 'create'));

	/* build the location and setup the references */
	document.getElementById('navigation').appendChild(_state.makeLocation(_state.config.path, null));
	if (_state.config.path == '/')
		document.getElementById('button-parent').classList.add('disabled');
	else
		document.getElementById('button-parent').href = _state.encodePath(_state.config.path.substring(0, _state.config.path.lastIndexOf('/')));

	/* register the drag-and-drop handlers for the UI */
	if (_state.config.upload) {
		const dropDetector = document.getElementById('body');
		const dropZone = document.getElementById('drop-zone');
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

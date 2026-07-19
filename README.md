# \[MWS\] Module to Share Files and Directories
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

A file sharing module for [`@bjoernboss/mws`](https://github.com/BjoernBoss/mws).

It serves the content of a data directory over HTTP: browsing directories through a full-featured web frontend, downloading files and entire directories as ZIP archives, and - if permitted - uploading, copying, moving, and deleting content. A WebSocket endpoint allows API clients to listen for directory changes.

All content is stored as plain files and directories in the configured data directory and persists across server restarts. Path reservations and copy jobs are managed by the `FileShare` module.

## Installation

	$ npm install @bjoernboss/mws-files

Requires Node.js 22 or later.

## Setup

The `FileShare` module takes a data directory path and an optional `Params` object controlling what operations clients may perform. Mount it under a path using `dispatch`:

```typescript
import { Server, dispatch, addLogger, createConsoleLogger } from "@bjoernboss/mws";
import { FileShare } from "@bjoernboss/mws-files";

addLogger(createConsoleLogger());

const server = new Server();
const share = new FileShare('./data/share', {
    access: true,
    upload: true,
    delete: true
});

server.listen(dispatch({ '/share': share }), { port: 8080 });
```

The module serves its own pages, static assets, and WebSocket endpoints from its mount point. Navigate to `http://localhost:8080/share/files/` to open the root directory view.

Important: The module caches path reservations and copy jobs in memory. The same data directory should therefore not be used by multiple `FileShare` modules simultaneously.

## Frontend

The directory view is an elaborate single-page browser frontend, built entirely on the public API described below. Operations not permitted by the configured parameters are hidden from the UI.

### Browsing

- Breadcrumb navigation with home and parent buttons; on narrow screens the breadcrumb scrolls end-favoring, keeping the closest parents visible.
- Directory listing sorted with directories first, showing entry counts, human-readable file sizes, and localized modification dates.
- Per-entry menu (via the menu button or right-click): Open, Download (files directly, directories as ZIP), Copy URL to the clipboard, Rename, Copy to..., Move to..., and Delete.

### Uploading

- Files and entire directory trees can be uploaded via drag-and-drop anywhere on the page (an animated drop zone appears), or through the create menu (create directory, upload files, upload directory).
- Directory uploads recreate the full tree, creating parent directories before their content.
- Each file upload first reserves the target path, allowing name conflicts to be detected before any data is transferred; the original modification time of uploaded files is preserved (when permitted by the module).
- Files exceeding the configured upload limit are skipped client-side with a notification; the limit is displayed in the create menu and drop zone.

### Copying, Moving, and Deleting

- New names are edited inline in the listing itself (Enter confirms, Escape aborts), with client-side name validation.
- The copy and move targets are chosen through a directory picker dialog, which allows navigating the whole share and creating new directories on the way; an in-place copy proposes a free `- Copy (n)` name.
- Directory copies and deletions are performed recursively by the frontend: the tree is enumerated first, then processed file-by-file (copies preserve modification times).
- Deletions must be confirmed through a dialog showing the full path.

### Progress and Robustness

- All operations report through stacked toast notifications with status texts, per-file progress bars, and overall counters; copy jobs are polled once per second and their progress is animated using a speculative forecast between polls.
- Bulk operations run at most 3 remote requests concurrently, skip entries whose parent operation failed, and abort after 12 failures.
- A live change-listener WebSocket connection is established to update the view on changes.
- The listing is updated optimistically after each successful operation, without re-fetching the directory, as this will be reported through the change-listener.
- Navigating away is guarded by a confirmation prompt while operations are still running.

## Parameters

The `Params` object controls module behavior and access. All fields are optional:

| Field | Default | Description |
|---|---|---|
| `access` | `false` | Access content at all - browsing, downloading, copy jobs, and change listeners all require it |
| `upload` | `false` | Upload files, create directories, and copy or move content |
| `delete` | `false` | Delete content (also required to move content) |
| `uploadMTime` | `false` | Preserve the client-supplied modification time of uploads, otherwise reset to current time |
| `uploadLimit` | `100000000` (100 MB) | Largest content to upload or copy in bytes (`0` implies no limit) |
| `rebase` | `'/'` | Sub-directory of the share to serve as the connection's root (must be a directory) |

Without any parameters the share is inaccessible; `access: true` alone yields a read-only share. Parameters can also be set per-request through `params` when dispatching to the module. Request parameters override the corresponding default, allowing parent modules to implement authentication or per-route access policies.

With `rebase`, all paths of the connection - served content, copy and move targets, and watched directories - are resolved relative to the given sub-directory, and nothing outside of it can be reached. The rebasing is fully transparent to clients, which makes per-request `rebase` suitable for handing each user their own root within a shared data directory.

## Endpoints

The `Endpoints` export provides the path constants used by the module. All paths are relative to the module's mount point. Path components in the URL use URI encoding while preserving `/`; paths in JSON payloads are not encoded.

| Path | Method | Description |
|---|---|---|
| `/files/{path}` | GET | Serve a file, or a directory as HTML view, JSON listing, or ZIP download |
| `/files/{path}` | POST | Upload a file, create a directory, or reserve a path (requires `Params.upload`) |
| `/files/{path}` | PUT | Copy or move content to a new path (requires `Params.upload`; move also `Params.delete`) |
| `/files/{path}` | DELETE | Delete a file or an empty directory (requires `Params.delete`) |
| `/jobs/{id}` | GET | JSON status of a copy job |
| `/static/*` | GET | Static assets (CSS, JS, icons) served with immutable cache headers |
| `/ws/{path}` | WebSocket | Listen for changes of a directory |

All endpoints except `/static` additionally require `Params.access`; without it they respond with 403.

Path components may not contain control characters or any of `/ \ ? : * " < > |`. The (possibly rebased) root directory itself can only be read, never modified, and cannot be the direct target of a copy or move, but can be copied/moved into.

## Files API

Every response of the `/files` endpoint carries a `Kind` header (`file` or `directory`) identifying what was served, and a `Path` header echoing the served path in the shared file space (URI-encoded like paths in the URL). The optional query parameter `kind=file|directory` restricts the request to the given kind; a mismatch results in 409. For requests without `kind`, a file is preferred over a directory of the same path.

### Reading (GET)

- A file is served directly (range requests and content encoding are handled by the framework); `download=true` adds a `Content-Disposition: attachment` header (the filename is given as RFC 8187 `filename*`, with an alternative ascii `filename` fallback).
- A directory is served as the interactive HTML browser view by default. With `raw=true` the JSON listing is returned instead, and with `download=true` the directory is streamed as a ZIP archive (`{name}.zip`).

The JSON listing maps entry names to their metadata:

```json
{ "example.txt": { "kind": "file", "size": 1234, "modified": 1710000000000 } }
```

For directories, `size` is the number of contained entries; `modified` is the modification time in milliseconds since the epoch. ZIP downloads are streamed using ZIP64 extensions; compressible media types are deflated, all other content is stored uncompressed.

### Uploading (POST)

- `kind=file` (default): the request body becomes the file content; fails with 409 if the path already exists. The body size is limited by `Params.uploadLimit` (413 if exceeded).
- `kind=directory`: creates an empty directory; with `silent=true`, an already existing directory responds OK instead of 409 (this also applies to `reserve=true` requests, which then respond without a `Reservation-Id` header).
- `mtime={ms}`: sets the modification time of the created content (only honored when `Params.uploadMTime` is enabled).
- `reserve=true`: instead of uploading, reserves the path for 5 seconds and responds with a `Reservation-Id` header. While a reservation is active, only requests passing the id back via `reservation={id}` may claim the path. This allows clients to atomically pick a free name before starting a large upload.

In all cases the parent directory of the path must already exist; intermediate directories are never created implicitly.

### Copying and Moving (PUT)

Exactly one of `copy={target}` or `move={target}` must be given, where the target is the full destination path within the share (given decoded in the query string). The destination must not exist yet and its parent directory must exist; `reservation={id}` may pass a previously created reservation for the destination.

- `move`: renames the file or directory (`kind` selects the expected source kind). Requires `Params.upload` and `Params.delete`.
- `copy`: only files can be copied, and `Params.uploadLimit` is enforced on the source size (413 if exceeded). The copy runs as a background job: the response carries a `Job-Id` header, and progress can be polled via `/jobs/{id}`. Requires `Params.upload`.

### Deleting (DELETE)

Deletes the file or empty directory at the path (`kind` selects the expected kind). Deleting a non-empty directory responds with 409.

## Copy Jobs

A copy job created by PUT `copy` can be polled via GET `/jobs/{id}`:

```json
{ "progress": 0.5, "state": "running", "message": "" }
```

`state` is one of `running`, `success`, or `failure`; `message` describes failures and `progress` ranges from 0 to 1. Finished job states are retained for 3 minutes before being cleaned up. Running jobs are aborted when the server shuts down, in which case the partially written target is removed.

## WebSocket Protocol

Clients connect to `/ws/{path}` to listen for changes of a directory (only directories can be watched). Whenever the directory content changes, the server broadcasts the full JSON directory listing (same format as `raw=true`). Notifications are coalesced over a timespan of a few seconds. Changes within immediate sub-directories, which alter the listed entry count and modification time, are tracked as well. Clients never need to send data, as this is only a notification channel.

Besides listings, the server sends one of three string identifiers:

- **`"removed"`**: the watched directory was deleted.
- **`"error"`**: watching the directory failed.
- **`"close"`**: the server is shutting down.

After an identifier is sent, the server closes the WebSocket. The underlying file-system watcher is kept alive for a ceratin grace period after the last listener disconnects, to handle quick reconnections.

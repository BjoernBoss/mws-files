# \[MWS\] Module to Share Files
![TypeScript](https://img.shields.io/badge/language-TypeScript-blue?style=flat-square)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-brightgreen?style=flat-square)](LICENSE.txt)

This repository is designed to be used with the [`MWS-Base`](https://github.com/BjoernBoss/mws-base.git).

It provides file sharing of the content of a directory at a given `data-path` (as given to the constructor of the module).
For this, it provides enumerating directory contents, and downloading them.

## Using the Module
To use this module, setup the `mws-base`. Then simply clone this repository into the modules directory:

	$ git clone https://github.com/BjoernBoss/mws-share.git modules/share

Afterwards, transpile the entire server application, and construct this module in the `setup.js Run` method as:

```JavaScript
const m = await import("./share/share.js");
server.listenHttp(93, new m.Share('path/to/shared/data'), (host) => host == 'localhost');
```

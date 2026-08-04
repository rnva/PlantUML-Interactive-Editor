// SPDX-License-Identifier: MIT

// MIT License

// Copyright (c) 2026 Ericsson

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// Where the webview's frontend comes from.
//
// The extension owns the webview's HTML, but not the frontend inside it: the
// interaction code, the CSS and the context menus are the web app's, and the
// sidecar is already a web server that serves exactly those files. So they are
// loaded over HTTP from the sidecar rather than copied into the extension --
// which means there is no mirror to keep in sync, no generated directory, and
// no way for the webview to run a stale copy of a file that was edited in
// src/plantuml_gui/.
//
// Only what the sidecar cannot serve is resolved locally: the browser
// libraries, which the web app loads from CDNs (blocked by a webview's CSP)
// and which are therefore taken straight out of node_modules.
//
// Working on the frontend: edit src/plantuml_gui/static or
// templates/partials, then reopen the diagram panel. There is no build or
// sync step, and no copy of those files anywhere in this directory.

const path = require('path');
const vscode = require('vscode');
const { TOKEN_HEADER } = require('./sidecar');

// Must match MENUS_ROUTE in src/plantuml_gui/serve.py.
const MENUS_PATH = 'webview/menus';

// A local server that has already answered /health; a slow answer here means
// something is wrong rather than merely busy.
const MENUS_TIMEOUT_MS = 5000;

// Sidecar-relative, and ordered: script.js declares the `let editor` binding
// and the render pipeline the rest hang off, and activity.js registers the
// handlers that assume both. Deliberately excludes static/mode-plantuml.js --
// that is Ace's syntax mode, and the VS Code editor is the source editor here.
const APP_SCRIPTS = [
	'static/script.js',
	'static/title.js',
	'static/hover-highlight.js',
	'static/sequence-message.js',
	'static/sequence-activation.js',
	'static/sequence-group.js',
	'static/sequence-box.js',
	'static/sequence-operations.js',
	'static/activity.js'
];

// Just the entry point: styles.css @imports six files from static/css/, and
// over HTTP those resolve against the sidecar origin on their own.
const APP_STYLES = ['static/styles.css'];

// node_modules-relative. jQuery before Bootstrap, which requires it. jQuery is
// pinned to 3.x because Bootstrap 4 requires <4.
const VENDOR_SCRIPTS = [
	'jquery/dist/jquery.min.js',
	'bootstrap/dist/js/bootstrap.min.js',
	'panzoom/dist/panzoom.min.js',
	'diff/dist/diff.min.js'
];

const VENDOR_STYLES = ['bootstrap/dist/css/bootstrap.min.css'];

// media/-relative, and the one part of the frontend that is genuinely this
// extension's: VS Code has no Ace and no same-origin Flask, so these adapt the
// app's code to it. Order is load-bearing -- see SHIM_SCRIPTS' use below.
const SHIM_SCRIPTS = ['fetchShim.js', 'editorShim.js'];

// Loaded after every app script, because it assigns script.js's top-level
// `let editor`, a lexical binding only a classic script in the same global
// scope can write to.
const BOOT_SCRIPT = 'webviewInit.js';

/** Thrown when the frontend cannot be resolved from a running sidecar. */
class AssetLoadError extends Error {}

/**
 * The node_modules directory, for `localResourceRoots`.
 *
 * The libraries are loaded from where npm put them instead of being copied
 * into media/, which is why they are runtime `dependencies` rather than
 * devDependencies: vsce packages those into the VSIX.
 *
 * @param {string} extensionPath
 * @returns {import('vscode').Uri}
 */
function vendorRoot(extensionPath) {
	return vscode.Uri.file(path.join(extensionPath, 'node_modules'));
}

/**
 * The media directory, for `localResourceRoots`. Holds the shims.
 *
 * @param {string} extensionPath
 * @returns {import('vscode').Uri}
 */
function mediaRoot(extensionPath) {
	return vscode.Uri.file(path.join(extensionPath, 'media'));
}

/**
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} root
 * @param {string[]} relatives paths below `root`
 * @returns {string[]} webview-loadable URIs
 */
function localUris(webview, root, relatives) {
	return relatives.map((relative) =>
		webview
			.asWebviewUri(vscode.Uri.joinPath(root, ...relative.split('/')))
			.toString()
	);
}

/**
 * Fetch the context-menu markup, rendered by the sidecar's Jinja.
 *
 * Not read from the template files directly: sequence_menus.html defines and
 * calls a `color_select` macro, so unrendered markup would put the literal
 * `{{ color_select(...) }}` in the DOM and the colour dropdowns would silently
 * not exist. This request can carry the token because it is made here, in
 * Node, rather than by the page.
 *
 * @param {string} base sidecar base URL, with trailing slash
 * @param {string} token
 * @returns {Promise<string>}
 * @throws {AssetLoadError}
 */
async function fetchMenus(base, token) {
	let response;

	try {
		response = await fetch(`${base}${MENUS_PATH}`, {
			headers: { [TOKEN_HEADER]: token },
			signal: AbortSignal.timeout(MENUS_TIMEOUT_MS)
		});
	} catch (err) {
		throw new AssetLoadError(
			`Could not load the diagram menus from the PlantUML backend: ${err.message}`
		);
	}

	if (!response.ok) {
		throw new AssetLoadError(
			`The PlantUML backend returned ${response.status} for the diagram menus.`
		);
	}

	return response.text();
}

/**
 * @param {string} url
 * @returns {string} the same URL, guaranteed to end in a slash so relative
 *   paths can be appended.
 */
function withTrailingSlash(url) {
	return url.endsWith('/') ? url : `${url}/`;
}

/**
 * Resolve everything the webview page needs to load the frontend.
 *
 * @param {object} options
 * @param {import('./sidecar').Sidecar} options.sidecar a running sidecar
 * @param {import('vscode').Webview} options.webview used to build resource URIs
 * @param {string} options.extensionPath
 * @returns {Promise<{
 *   base: string,
 *   origin: string,
 *   styleHrefs: string[],
 *   scriptSrcs: string[],
 *   vendorStyleUris: string[],
 *   vendorScriptUris: string[],
 *   shimUris: string[],
 *   bootUri: string,
 *   menusHtml: string
 * }>}
 * @throws {AssetLoadError}
 */
async function resolveWebviewAssets({ sidecar, webview, extensionPath }) {
	// The sidecar binds loopback, which the webview cannot reach directly under
	// Remote-SSH, WSL or Codespaces; asExternalUri returns an address that
	// works from wherever the UI is actually running.
	const base = withTrailingSlash(
		(await vscode.env.asExternalUri(vscode.Uri.parse(sidecar.baseUrl))).toString()
	);

	const vendor = vendorRoot(extensionPath);
	const media = mediaRoot(extensionPath);

	return {
		base,
		origin: new URL(base).origin,
		styleHrefs: APP_STYLES.map((relative) => `${base}${relative}`),
		scriptSrcs: APP_SCRIPTS.map((relative) => `${base}${relative}`),
		vendorStyleUris: localUris(webview, vendor, VENDOR_STYLES),
		vendorScriptUris: localUris(webview, vendor, VENDOR_SCRIPTS),
		shimUris: localUris(webview, media, SHIM_SCRIPTS),
		bootUri: localUris(webview, media, [BOOT_SCRIPT])[0],
		menusHtml: await fetchMenus(base, sidecar.token)
	};
}

/**
 * The webview's content security policy.
 *
 * Two sources are allowed and nothing else: the sidecar origin, for the
 * frontend, and `webview.cspSource`, for files loaded off disk. That is what
 * makes it safe to innerHTML PlantUML-rendered SVG from an untrusted .puml
 * file -- injected markup can carry neither the nonce nor either origin, so an
 * inline <script> or an SVG onload handler is blocked.
 *
 * @param {object} options
 * @param {import('vscode').Webview} options.webview
 * @param {{ origin: string }} options.assets
 * @param {string} options.nonce
 * @returns {string}
 */
function buildCsp({ webview, assets, nonce }) {
	const local = webview.cspSource;
	const remote = assets.origin;

	return [
		"default-src 'none'",
		`img-src ${local} ${remote} data:`,
		// 'unsafe-inline' for styles only: Bootstrap and the app CSS both set
		// inline styles, and the app code toggles element.style directly.
		`style-src ${local} ${remote} 'unsafe-inline'`,
		`script-src 'nonce-${nonce}' ${local} ${remote}`,
		`font-src ${local} ${remote}`,
		`connect-src ${remote}`
	].join('; ');
}

module.exports = {
	resolveWebviewAssets,
	buildCsp,
	vendorRoot,
	mediaRoot,
	fetchMenus,
	AssetLoadError,
	APP_SCRIPTS,
	VENDOR_SCRIPTS,
	VENDOR_STYLES,
	SHIM_SCRIPTS,
	BOOT_SCRIPT,
	MENUS_PATH
};

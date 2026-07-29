// Carries webview-side diagnostics to the extension host's log channel.
//
// Loaded FIRST -- before the vendored libraries, the other two shims, and the
// mirrored app scripts. That ordering is the whole point. The failure this file
// exists for is an app script throwing while it loads, which leaves the diagram
// rendered and nothing clickable; the design doc calls that close to
// undiagnosable from the UI, and it is invisible from the host unless something
// was already listening when it happened.
//
// See docs/vscode_extension_interactivity.md, "Logging", for the level policy.
// Nothing here may log diagram source: the host confines file content to
// `trace`, and this side cannot see the current log level to make that call.

(function () {
	// acquireVsCodeApi() may be called only ONCE per webview -- a second call
	// throws, taking the whole panel with it. This file loads first, so it makes
	// the call and every other script shares the handle through
	// window.__vscodeApi. media/webviewInit.js reads it instead of acquiring.
	const vscodeApi = acquireVsCodeApi();
	window.__vscodeApi = vscodeApi;

	/**
	 * @param {unknown} value
	 * @returns {string} a stack where there is one, since the message alone
	 *   rarely names the file.
	 */
	function describe(value) {
		if (value instanceof Error) {
			return value.stack || `${value.name}: ${value.message}`;
		}
		return String(value);
	}

	/**
	 * @param {'trace'|'debug'|'info'|'warn'|'error'} level
	 * @param {unknown} message
	 */
	function send(level, message) {
		try {
			vscodeApi.postMessage({ type: 'log', level, message: describe(message) });
		} catch {
			// Logging must never break the thing it is reporting on. If the
			// channel to the host is gone there is nowhere left to complain to.
		}
	}

	window.__plantumlLog = send;

	window.addEventListener('error', (event) => {
		const where = event.filename
			? ` (${event.filename}:${event.lineno}:${event.colno})`
			: '';
		// event.error carries the stack; event.message is all there is when the
		// browser withholds detail, as it does for a cross-origin script.
		const detail = event.error ? `\n${describe(event.error)}` : '';
		send('error', `uncaught: ${event.message}${where}${detail}`);
	});

	window.addEventListener('unhandledrejection', (event) => {
		// The app code's fetch chains reject here rather than throwing, so this
		// catches a failing backend call that nothing awaited.
		send('error', `unhandled rejection: ${describe(event.reason)}`);
	});

	// Mirror the console's two loud levels to the host. Deliberately not
	// console.log: the mirrored app scripts use it freely and it would flood the
	// channel. The original is still called, so the webview devtools are
	// unchanged.
	for (const level of ['warn', 'error']) {
		const original = console[level].bind(console);
		console[level] = function (...args) {
			send(level, args.map(describe).join(' '));
			original(...args);
		};
	}
})();

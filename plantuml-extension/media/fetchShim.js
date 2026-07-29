// Points the reused app code's relative fetch() calls at the sidecar.
//
// The web app calls fetch("editText", ...), fetch("render", ...) and so on with
// relative URLs, which in a browser resolve against the Flask origin. In a
// webview the page URL has a vscode-webview-ish origin, so they would resolve
// to nonsense. Rewriting them here is the only change those ~150 call sites
// need -- which is why this is a shim and not a refactor.
//
// Must load before any app script.
//
// Note that this makes every request cross-origin, and the token header below
// is not CORS-safelisted, so the sidecar has to answer preflights. See
// install_cors in src/plantuml_gui/serve.py.

(function () {
	const nativeFetch = window.fetch.bind(window);
	const base = window.__PLANTUML_API__;
	const token = window.__PLANTUML_TOKEN__;

	window.fetch = function (url, options = {}) {
		const target = String(url);
		const absolute = /^[a-z]+:\/\//i.test(target)
			? target
			: base + target.replace(/^\//, '');
		const method = options.method || 'GET';

		return nativeFetch(absolute, {
			...options,
			headers: { ...(options.headers || {}), 'X-PlantUML-Token': token }
		}).then(
			(response) => {
				// The app code checks response.ok in some places and not others,
				// so a failing route can otherwise present as a diagram that
				// silently stops updating.
				if (!response.ok) {
					report(`${method} ${target} -> ${response.status} ${response.statusText}`);
				}
				return response;
			},
			(err) => {
				// The opaque "Failed to fetch": a CORS rejection, a dead sidecar,
				// or a connect-src the CSP does not allow. Naming the URL is what
				// separates those three.
				report(`${method} ${target} failed: ${err && err.message}`);
				// Rethrown so callers behave exactly as before -- this is a tap
				// on the promise, not a handler.
				throw err;
			}
		);
	};

	/**
	 * @param {string} message
	 */
	function report(message) {
		// Optional because media/logShim.js is what defines it, and the unit
		// tests load this shim on its own.
		window.__plantumlLog?.('error', `fetch: ${message}`);
	}
})();

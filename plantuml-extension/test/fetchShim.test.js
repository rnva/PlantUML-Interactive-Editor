const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHIM = path.join(__dirname, '..', 'media', 'fetchShim.js');

/**
 * Run media/fetchShim.js in a sandbox and return the installed fetch plus a log
 * of the calls it forwarded.
 *
 * Exercises the real file rather than a copy of its logic, since this shim is
 * what all ~150 of the reused app code's fetch() call sites go through.
 *
 * @returns {{fetch: Function, calls: Array<{url: string, options: object}>}}
 */
function loadShim({ response, rejectWith, withoutLogShim } = {}) {
	const calls = [];
	const logged = [];
	const sandbox = {
		__PLANTUML_API__: 'http://127.0.0.1:53421/',
		__PLANTUML_TOKEN__: 'test-token',
		// Stands in for media/logShim.js, which defines this in the real page.
		__plantumlLog: withoutLogShim
			? undefined
			: (level, message) => logged.push({ level, message }),
		fetch: (url, options) => {
			calls.push({ url, options });
			return rejectWith
				? Promise.reject(rejectWith)
				: Promise.resolve(response ?? { ok: true, status: 200, statusText: 'OK' });
		},
		String,
		Promise
	};
	sandbox.window = sandbox;

	vm.createContext(sandbox);
	new vm.Script(fs.readFileSync(SHIM, 'utf-8')).runInContext(sandbox);

	return { fetch: sandbox.fetch, calls, logged };
}

suite('fetch shim', () => {
	test('resolves a relative URL against the sidecar', () => {
		const { fetch, calls } = loadShim();

		fetch('editMessageText', { method: 'POST' });

		assert.strictEqual(calls[0].url, 'http://127.0.0.1:53421/editMessageText');
	});

	test('does not double up a leading slash', () => {
		const { fetch, calls } = loadShim();

		fetch('/render');

		assert.strictEqual(calls[0].url, 'http://127.0.0.1:53421/render');
	});

	test('leaves an absolute URL alone', () => {
		const { fetch, calls } = loadShim();

		fetch('https://example.com/x');

		assert.strictEqual(calls[0].url, 'https://example.com/x');
	});

	test('attaches the auth token', () => {
		// The sidecar rejects unauthenticated requests, so a lost header shows
		// up as a blanket 403 rather than anything specific.
		const { fetch, calls } = loadShim();

		fetch('render');

		assert.strictEqual(calls[0].options.headers['X-PlantUML-Token'], 'test-token');
	});

	test('preserves caller headers', () => {
		const { fetch, calls } = loadShim();

		fetch('render', { headers: { 'Content-Type': 'application/json' } });

		assert.strictEqual(
			calls[0].options.headers['Content-Type'],
			'application/json'
		);
		assert.strictEqual(calls[0].options.headers['X-PlantUML-Token'], 'test-token');
	});

	test('preserves the request body and method', () => {
		const { fetch, calls } = loadShim();

		fetch('render', { method: 'POST', body: '{"plantuml":"x"}' });

		assert.strictEqual(calls[0].options.method, 'POST');
		assert.strictEqual(calls[0].options.body, '{"plantuml":"x"}');
	});
});

suite('fetch shim: failure reporting', () => {
	test('reports a failing status with the route and code', async () => {
		// The app code checks response.ok in some places and not others, so a
		// failing route can present as a diagram that silently stops updating.
		const { fetch, logged } = loadShim({
			response: { ok: false, status: 500, statusText: 'INTERNAL SERVER ERROR' }
		});

		await fetch('editMessageText', { method: 'POST' });

		assert.strictEqual(logged.length, 1);
		assert.strictEqual(logged[0].level, 'error');
		assert.ok(logged[0].message.includes('editMessageText'));
		assert.ok(logged[0].message.includes('500'));
	});

	test('reports a rejected request', async () => {
		// The opaque "Failed to fetch" -- a dead sidecar, a CORS rejection, or a
		// CSP connect-src that does not allow the origin.
		const { fetch, logged } = loadShim({ rejectWith: new Error('Failed to fetch') });

		await assert.rejects(fetch('render', { method: 'POST' }));

		assert.strictEqual(logged[0].level, 'error');
		assert.ok(logged[0].message.includes('render'));
		assert.ok(logged[0].message.includes('Failed to fetch'));
	});

	test('still rejects, so callers behave as before', async () => {
		// This is a tap on the promise, not a handler. Swallowing here would
		// turn a failed edit into a silent no-op.
		const failure = new Error('Failed to fetch');
		const { fetch } = loadShim({ rejectWith: failure });

		await assert.rejects(fetch('render'), (err) => err === failure);
	});

	test('says nothing about a successful request', async () => {
		// ~150 call sites, several per render: logging the successes would bury
		// the failures.
		const { fetch, logged } = loadShim();

		await fetch('render', { method: 'POST' });

		assert.deepStrictEqual(logged, []);
	});

	test('a failure without the log shim loaded does not throw', async () => {
		// Defensive: reporting is best-effort, and a missing logShim.js must
		// not turn a failed request into a different failure.
		const { fetch } = loadShim({
			withoutLogShim: true,
			rejectWith: new Error('Failed to fetch')
		});

		await assert.rejects(fetch('render'), /Failed to fetch/);
	});
});

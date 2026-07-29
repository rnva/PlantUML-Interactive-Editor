const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SHIM = path.join(__dirname, '..', 'media', 'logShim.js');

/**
 * Run media/logShim.js in a sandbox and return what it posted plus the window
 * event handlers it installed.
 *
 * Exercises the real file rather than a copy of its logic, as
 * test/fetchShim.test.js does: this shim is the only route by which a webview
 * failure reaches the extension's log at all.
 *
 * @returns {{
 *   sandbox: object,
 *   posted: object[],
 *   acquiredCount: () => number,
 *   fire: (type: string, event: object) => void,
 *   consoleCalls: Array<{level: string, args: unknown[]}>
 * }}
 */
function loadShim({ postMessage } = {}) {
	const posted = [];
	const consoleCalls = [];
	/** @type {Record<string, Function[]>} */
	const handlers = {};
	let acquired = 0;

	const sandbox = {
		acquireVsCodeApi: () => {
			acquired += 1;
			return {
				postMessage:
					postMessage ?? ((message) => posted.push(message))
			};
		},
		addEventListener: (type, handler) => {
			(handlers[type] ??= []).push(handler);
		},
		console: {
			warn: (...args) => consoleCalls.push({ level: 'warn', args }),
			error: (...args) => consoleCalls.push({ level: 'error', args }),
			log: (...args) => consoleCalls.push({ level: 'log', args })
		},
		String,
		Error
	};
	sandbox.window = sandbox;

	vm.createContext(sandbox);
	new vm.Script(fs.readFileSync(SHIM, 'utf-8')).runInContext(sandbox);

	return {
		sandbox,
		posted,
		consoleCalls,
		acquiredCount: () => acquired,
		fire: (type, event) => (handlers[type] ?? []).forEach((h) => h(event))
	};
}

suite('log shim: the VS Code API handle', () => {
	test('acquires the api exactly once', () => {
		// acquireVsCodeApi() throws on a second call and takes the panel with
		// it. This shim owns the call; webviewInit.js reads the handle back.
		const { acquiredCount } = loadShim();

		assert.strictEqual(acquiredCount(), 1);
	});

	test('publishes the handle for the other scripts', () => {
		const { sandbox } = loadShim();

		assert.strictEqual(typeof sandbox.__vscodeApi.postMessage, 'function');
	});

	test('exposes a log function for the other shims', () => {
		const { sandbox } = loadShim();

		assert.strictEqual(typeof sandbox.__plantumlLog, 'function');
	});
});

suite('log shim: uncaught errors', () => {
	test('reports an uncaught error with its stack', () => {
		// The failure this file exists for: an app script throws while loading,
		// the diagram still renders, and nothing is clickable.
		const { posted, fire } = loadShim();
		const error = new Error('boom');

		fire('error', {
			message: 'Uncaught Error: boom',
			filename: 'app/script.js',
			lineno: 12,
			colno: 3,
			error
		});

		assert.strictEqual(posted.length, 1);
		assert.strictEqual(posted[0].type, 'log');
		assert.strictEqual(posted[0].level, 'error');
		assert.ok(posted[0].message.includes('app/script.js:12:3'));
		assert.ok(
			posted[0].message.includes(error.stack),
			'the stack is the part that names the file'
		);
	});

	test('still reports when the browser withholds the error object', () => {
		// Cross-origin script errors arrive with message only.
		const { posted, fire } = loadShim();

		fire('error', { message: 'Script error.', filename: '', lineno: 0, colno: 0 });

		assert.strictEqual(posted[0].level, 'error');
		assert.ok(posted[0].message.includes('Script error.'));
	});

	test('reports an unhandled rejection', () => {
		const { posted, fire } = loadShim();

		fire('unhandledrejection', { reason: new Error('fetch failed') });

		assert.strictEqual(posted[0].level, 'error');
		assert.ok(posted[0].message.includes('fetch failed'));
	});
});

suite('log shim: console mirroring', () => {
	test('forwards console.warn and console.error', () => {
		const { sandbox, posted } = loadShim();

		sandbox.console.warn('careful');
		sandbox.console.error('broken');

		assert.deepStrictEqual(
			posted.map((m) => m.level),
			['warn', 'error']
		);
	});

	test('leaves console.log alone', () => {
		// The mirrored app scripts use it freely; forwarding would flood the
		// channel and bury everything worth reading.
		const { sandbox, posted } = loadShim();

		sandbox.console.log('chatter');

		assert.deepStrictEqual(posted, []);
	});

	test('still writes to the real console', () => {
		// Mirroring must not cost the webview devtools their output.
		const { sandbox, consoleCalls } = loadShim();

		sandbox.console.warn('careful');

		assert.deepStrictEqual(consoleCalls, [{ level: 'warn', args: ['careful'] }]);
	});
});

suite('log shim: robustness', () => {
	test('a failing postMessage does not propagate', () => {
		// Logging must never break the thing it is reporting on: if the channel
		// to the host is gone there is nowhere left to complain to.
		const { fire } = loadShim({
			postMessage: () => {
				throw new Error('channel closed');
			}
		});

		assert.doesNotThrow(() => fire('error', { message: 'boom', filename: '' }));
	});
});

const assert = require('assert');

const { initLogger, getLogger, levelFromWebview, LEVELS } = require('../src/logger');

/**
 * Stand-in for a LogOutputChannel that records what it was asked to write, so
 * the level and the final text can both be asserted.
 */
function fakeChannel() {
	/** @type {Array<{level: string, message: string}>} */
	const calls = [];
	const record = (level) => (message) => calls.push({ level, message });

	return {
		calls,
		trace: record('trace'),
		debug: record('debug'),
		info: record('info'),
		warn: record('warn'),
		error: record('error')
	};
}

/** @param {ReturnType<typeof fakeChannel> | undefined} channel */
const install = (channel) => initLogger(/** @type {any} */ (channel));

suite('logger: writing', () => {
	teardown(() => {
		// Leaves the module unpointed rather than restoring the channel that
		// activate() installed, which is not readable from here. Nothing else in
		// the suite asserts on log output.
		install(undefined);
	});

	test('writes at the level it was asked for', () => {
		const channel = fakeChannel();
		const log = install(channel);

		log.info('ready');

		assert.deepStrictEqual(channel.calls, [{ level: 'info', message: 'ready' }]);
	});

	test('offers every level the channel understands', () => {
		const channel = fakeChannel();
		const log = install(channel);

		for (const level of LEVELS) {
			log[level](`at ${level}`);
		}

		assert.deepStrictEqual(
			channel.calls.map((call) => call.level),
			LEVELS
		);
	});

	test('does nothing before a channel is installed', () => {
		// activate() is what supplies the channel, so module-scope loggers and
		// unit tests that never activate the extension both call into nothing.
		install(undefined);

		assert.doesNotThrow(() => getLogger().error('too early'));
	});

	test('unwraps an Error to its stack', () => {
		// String(err) gives "Error: boom" and discards the stack, which is the
		// only part worth logging.
		const channel = fakeChannel();
		const log = install(channel);

		log.error(new Error('boom'));

		assert.match(channel.calls[0].message, /Error: boom/);
		assert.match(channel.calls[0].message, /logger\.test\.js/);
	});
});

suite('logger: scopes', () => {
	teardown(() => install(undefined));

	test('tags a scoped logger', () => {
		const channel = fakeChannel();
		const log = install(channel);

		log.scope('sidecar').info('ready on port 41773');

		assert.strictEqual(channel.calls[0].message, '[sidecar] ready on port 41773');
	});

	test('leaves the root logger untagged', () => {
		const channel = fakeChannel();
		const log = install(channel);

		log.scope('sidecar');
		log.info('activating');

		assert.strictEqual(channel.calls[0].message, 'activating');
	});

	test('nests', () => {
		const channel = fakeChannel();
		const log = install(channel);

		log.scope('webview').scope('fetch').warn('404');

		assert.strictEqual(channel.calls[0].message, '[webview][fetch] 404');
	});

	test('a scope taken before the channel still writes to it', () => {
		// Modules take their logger at load time, which is before activate().
		install(undefined);
		const log = getLogger().scope('sidecar');

		const channel = fakeChannel();
		install(channel);
		log.info('late');

		assert.strictEqual(channel.calls[0].message, '[sidecar] late');
	});
});

suite('logger: levels from the webview', () => {
	test('passes a real level through', () => {
		for (const level of LEVELS) {
			assert.strictEqual(levelFromWebview(level), level);
		}
	});

	test('degrades an unknown level to info rather than dropping it', () => {
		// Losing the message is worse than logging it at the wrong level.
		assert.strictEqual(levelFromWebview('verbose'), 'info');
		assert.strictEqual(levelFromWebview(''), 'info');
	});

	test('refuses a channel method name', () => {
		// The webview runs the mirrored frontend, so this value is untrusted.
		// Indexing the channel with it directly would let that side call
		// anything on the object.
		assert.strictEqual(levelFromWebview('appendLine'), 'info');
		assert.strictEqual(levelFromWebview('dispose'), 'info');
		assert.strictEqual(levelFromWebview('replace'), 'info');
	});

	test('refuses a prototype property', () => {
		assert.strictEqual(levelFromWebview('constructor'), 'info');
		assert.strictEqual(levelFromWebview('__proto__'), 'info');
		assert.strictEqual(levelFromWebview('toString'), 'info');
	});

	test('refuses anything that is not a string', () => {
		assert.strictEqual(levelFromWebview(undefined), 'info');
		assert.strictEqual(levelFromWebview(null), 'info');
		assert.strictEqual(levelFromWebview(3), 'info');
		assert.strictEqual(levelFromWebview({}), 'info');
	});
});

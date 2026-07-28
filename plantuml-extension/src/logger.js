// The extension's log channel.
//
// Everything the extension wants to say goes through here rather than through
// a channel handle threaded down as a parameter, so that any module can log
// without its callers having to know that it does.
//
// The channel is a vscode.LogOutputChannel (created with `{ log: true }`),
// which supplies the timestamps, the level prefixes, and the per-channel
// "Set Log Level..." picker. This module only decides *what* is said and at
// which level; see docs/vscode_extension_interactivity.md, "Logging", for the
// level policy and for why file content is confined to `trace`.
//
// Nothing here requires the vscode module: the channel is injected. That keeps
// the logger testable outside the extension host, and means requiring this
// module does not drag vscode in behind it.

/** @typedef {'trace'|'debug'|'info'|'warn'|'error'} Level */

/** The levels a LogOutputChannel understands, in increasing severity. */
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];

/**
 * The channel every logger writes to, or undefined before activate() has run.
 * @type {import('vscode').LogOutputChannel | undefined}
 */
let channel;

/**
 * Build a logger that prefixes everything it writes with `prefix`.
 *
 * The channel is read at call time rather than captured, so a logger obtained
 * before initLogger() starts working the moment the channel exists. Until then
 * every method is a no-op -- which is what makes it safe to log from module
 * scope, and from unit tests that never activate the extension.
 *
 * @param {string} prefix
 * @returns {Logger}
 */
function createLogger(prefix) {
	/**
	 * Errors are logged often enough to unwrap here: String(err) yields
	 * "Error: boom" and discards the stack, which is the part worth having.
	 *
	 * @param {unknown} message
	 * @returns {string}
	 */
	const format = (message) => {
		const text =
			message instanceof Error ? (message.stack ?? message.message) : String(message);
		return prefix ? `${prefix} ${text}` : text;
	};

	// Written out rather than generated from LEVELS: indexing the channel with a
	// computed name defeats checkJs, and five lines of duplication is a better
	// trade than an `any`.
	/** @type {Logger} */
	const logger = {
		trace: (message) => channel?.trace(format(message)),
		debug: (message) => channel?.debug(format(message)),
		info: (message) => channel?.info(format(message)),
		warn: (message) => channel?.warn(format(message)),
		error: (message) => channel?.error(format(message)),

		/**
		 * A child logger tagging its output, e.g. `[sidecar] ready on port 41773`.
		 * Matches the `[webview]` prefix the message handler already used.
		 */
		scope: (name) => createLogger(`${prefix}[${name}]`)
	};

	return logger;
}

/**
 * @typedef {object} Logger
 * @property {(message: unknown) => void} trace per-keystroke and per-mouse-move
 *   detail, plus payloads. Off unless deliberately enabled.
 * @property {(message: unknown) => void} debug one line per user interaction.
 * @property {(message: unknown) => void} info lifecycle; a handful of lines per
 *   session, so the default level stays readable after an hour of use.
 * @property {(message: unknown) => void} warn a recoverable oddity.
 * @property {(message: unknown) => void} error a user-visible failure.
 * @property {(name: string) => Logger} scope
 */

const root = createLogger('');

/**
 * Point every logger at `logChannel`. Called once, from activate().
 *
 * @param {import('vscode').LogOutputChannel | undefined} logChannel
 * @returns {Logger} the root logger, for convenience.
 */
function initLogger(logChannel) {
	channel = logChannel;
	return root;
}

/** @returns {Logger} the root logger. Safe to call at module load. */
function getLogger() {
	return root;
}

/**
 * Map a level name supplied by the webview onto a real one.
 *
 * The webview runs the mirrored web app frontend, so a level arriving over
 * postMessage is untrusted input. Indexing the channel with it directly would
 * let that side name any method on the object -- `appendLine`, `dispose`, or
 * something off the prototype. Anything unrecognised degrades to `info` rather
 * than being dropped: losing the message is worse than logging it loudly.
 *
 * @param {unknown} name
 * @returns {Level}
 */
function levelFromWebview(name) {
	return typeof name === 'string' && LEVELS.includes(name)
		? /** @type {Level} */ (name)
		: 'info';
}

module.exports = {
	initLogger,
	getLogger,
	levelFromWebview,
	LEVELS
};

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

// The highest-value test here: load every app script against the editor shim
// and assert none of them throws.
//
// That is the failure mode that matters and the one that is close to
// undiagnosable from the UI -- the diagram renders correctly and nothing
// responds to clicks, because one script threw while the page was still
// parsing and every listener after it was never registered.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { APP_SCRIPTS, SHIM_SCRIPTS, BOOT_SCRIPT } = require('../src/webviewAssets');

const EXTENSION_PATH = path.join(__dirname, '..');
const STATIC_DIR = path.join(EXTENSION_PATH, '..', 'src', 'plantuml_gui', 'static');
const MEDIA_DIR = path.join(EXTENSION_PATH, 'media');

/**
 * A DOM stub that answers every lookup, so a missing id is not what fails.
 * The ids themselves are covered by test/webviewContent.test.js.
 */
function fakeDocument() {
	const element = () => ({
		style: {},
		classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
		addEventListener() {},
		removeEventListener() {},
		appendChild() {},
		setAttribute() {},
		getAttribute: () => null,
		querySelector: () => element(),
		querySelectorAll: () => [],
		getElementsByTagName: () => [],
		children: [],
		dataset: {},
		innerHTML: '',
		textContent: '',
		value: ''
	});

	return {
		getElementById: () => element(),
		querySelector: () => element(),
		querySelectorAll: () => [],
		createElement: () => element(),
		addEventListener() {},
		removeEventListener() {},
		body: element(),
		documentElement: element()
	};
}

/**
 * Run the shims and then every app script in one sandbox, in load order.
 *
 * @returns {{ sandbox: object, context: object }} the sandbox object and the
 *   vm context. Both are needed: top-level `let` and `const` in a classic
 *   script are lexical bindings of the global scope, not properties of the
 *   global object, so `script.js`'s `editor` is invisible on the sandbox and
 *   can only be read by evaluating an expression in the context.
 */
function loadFrontend() {
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		fetch: () => Promise.resolve({ ok: true, text: async () => '', json: async () => ({}) }),
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		$: () => ({ modal() {}, on() {}, off() {}, val: () => '', html() {}, find: () => ({}) }),
		jQuery: () => ({}),
		panzoom: () => ({ dispose() {} }),
		Diff: { diffLines: () => [] },
		location: { href: 'https://webview.test/', search: '' },
		history: { replaceState() {}, pushState() {} },
		navigator: { clipboard: { writeText: async () => {} } },
		acquireVsCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
		addEventListener() {},
		removeEventListener() {}
	};
	sandbox.window = sandbox;
	sandbox.self = sandbox;
	sandbox.globalThis = sandbox;
	sandbox.document = fakeDocument();

	const context = vm.createContext(sandbox);

	// The shims, then the app, then the boot script -- the same order
	// webviewContent.js emits, which is what this is checking is survivable.
	const files = [
		...SHIM_SCRIPTS.map((name) => path.join(MEDIA_DIR, name)),
		...APP_SCRIPTS.map((relative) => path.join(STATIC_DIR, path.basename(relative))),
		path.join(MEDIA_DIR, BOOT_SCRIPT)
	];

	for (const file of files) {
		try {
			// Classic scripts share one global scope, so they are run as
			// separate programs in the same context rather than as modules.
			new vm.Script(fs.readFileSync(file, 'utf-8'), { filename: file }).runInContext(context);
		} catch (err) {
			assert.fail(`${path.basename(file)} threw while loading: ${err.stack}`);
		}
	}

	return { sandbox, context };
}

suite('frontend: loads against the shims', () => {
	let sandbox;
	let context;

	suiteSetup(() => {
		({ sandbox, context } = loadFrontend());
	});

	test('every app script evaluates without throwing', () => {
		// loadFrontend() asserts per file; reaching here means all of them ran.
		assert.ok(sandbox);
	});

	test('the ace stand-in satisfies the load-time dereference', () => {
		// script.js line 46 runs `ace.require("ace/range").Range` at top level.
		const Range = sandbox.ace.require('ace/range').Range;
		const range = new Range(1, 2, 3, 4);

		assert.deepStrictEqual(
			{ start: { ...range.start }, end: { ...range.end } },
			{ start: { row: 1, column: 2 }, end: { row: 3, column: 4 } }
		);
	});

	test("the boot script assigned script.js's editor binding", () => {
		// Read through the context, not off the sandbox: `let editor` is a
		// lexical binding. Assigning it is the whole reason webviewInit.js has
		// to be a classic script loaded last rather than a module.
		assert.strictEqual(
			vm.runInContext('typeof editor.session.getValue', context),
			'function'
		);
	});

	test('setValue posts the edit to the host instead of mutating a buffer', () => {
		// setPuml() -> session.setValue() is the single door all ~71 diagram
		// operations exit through; pointing it at the host is what makes them
		// write to the file.
		const posted = [];
		const editor = sandbox.window.PlantumlEditorShim.create((message) =>
			posted.push(message)
		);

		editor.session.setValue('@startuml\nBob -> Alice\n@enduml');

		// Rebuilt as host objects: deepStrictEqual compares prototypes, and
		// anything constructed inside the sandbox has the sandbox's Object.
		assert.deepStrictEqual(
			posted.map((message) => ({ type: message.type, text: message.text })),
			[{ type: 'applyPuml', text: '@startuml\nBob -> Alice\n@enduml' }]
		);
	});

	test('an echoed document update is recognised and not re-applied', () => {
		const editor = sandbox.window.PlantumlEditorShim.create(() => {});
		editor.primeDocumentText('same');

		assert.strictEqual(editor.applyDocumentText('same'), false);
		assert.strictEqual(editor.applyDocumentText('different'), true);
	});

	test('hover markers become a row list for the host', () => {
		const posted = [];
		const editor = sandbox.window.PlantumlEditorShim.create((message) =>
			posted.push(message)
		);
		const Range = sandbox.ace.require('ace/range').Range;

		editor.session.addMarker(new Range(2, 0, 4, 0), 'hover');
		// Non-hover markers are the app's own selection styling, not line
		// highlights, so they must not reach the editor as decorations.
		editor.session.addMarker(new Range(9, 0, 9, 0), 'selected');

		const last = posted.at(-1);
		assert.strictEqual(last.type, 'setHighlight');
		assert.deepStrictEqual(Array.from(last.rows), [2, 3, 4]);
	});
});

import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'test/**/*.test.js',
	// Test against the version our users actually run, not whatever is current.
	// Every Ericsson machine is on 1.113, which is also the engines.vscode floor
	// in package.json; defaulting to 'stable' would test an API surface no user
	// has. @types/vscode is pinned to the nearest published version at or below
	// this (1.110 -- npm has no 1.111-1.114) for the same reason.
	version: '1.113.0',
});

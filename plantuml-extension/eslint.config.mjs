import globals from "globals";

export default [{
    // Both are downloaded, not written here: .vscode-test holds a whole copy
    // of VS Code, whose bundled extensions ship eslint configs of their own
    // that ESLint tries to load and fails on.
    ignores: [".vscode-test/**", "node_modules/**"],
}, {
    files: ["**/*.js"],
    languageOptions: {
        globals: {
            ...globals.commonjs,
            ...globals.node,
            ...globals.mocha,
        },

        ecmaVersion: 2022,
        sourceType: "module",
    },

    rules: {
        "no-const-assign": "warn",
        "no-this-before-super": "warn",
        "no-undef": "warn",
        "no-unreachable": "warn",
        "no-unused-vars": "warn",
        "constructor-super": "warn",
        "valid-typeof": "warn",
    },
}, {
    // media/ runs in the webview, not in Node: browser globals, plus the
    // webview API and the frontend's own top-level bindings, which the shims
    // deliberately reach for. `editor` is script.js's `let editor` -- assigning
    // it is the entire point of webviewInit.js.
    files: ["media/*.js"],
    languageOptions: {
        globals: {
            ...globals.browser,
            acquireVsCodeApi: "readonly",
            panzoom: "readonly",
            editor: "writable",
            renderPlantUml: "readonly",
            debouncedRenderPlantUml: "readonly",
            clearMarkers: "readonly",
            cursorChangeListener: "readonly",
            initEditorHoverHighlighting: "readonly",
            titleEventListeners: "readonly",
        },
    },
}];

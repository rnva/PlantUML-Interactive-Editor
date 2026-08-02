# PlantUML Interactive Editor — VS Code extension

Opens the interactive PlantUML diagram from
[PlantUML-Interactive-Editor](../README.md) in a VS Code panel beside the text
editor. The VS Code editor stays the source editor; the panel renders the
diagram and (as the interactive work lands) lets you edit it by clicking.

## Prerequisites

- **Python 3.10+** and [uv](https://docs.astral.sh/uv/) — the diagram backend is
  the repository's Flask app, run as a child process
- **Java** and a `plantuml.jar` — rendering shells out to it
- **Node.js 20+** and npm
- **VS Code 1.113** — the version on Ericsson machines, and the floor this
  extension targets. `engines.vscode`, the pinned `@types/vscode`, and the test
  runner's VS Code version are all aligned to it, so anything that compiles and
  passes tests here runs on a user's machine.

## Setup

From a fresh clone:

```bash
# Backend: creates .venv and installs plantuml_gui into it
uv sync

# Point the renderer at your PlantUML jar
echo 'PLANTUML_JAR="/absolute/path/to/plantuml.jar"' > .env

# Extension: installs dev dependencies, then generates media/ (see below)
cd plantuml-extension
npm install
```

Then open `plantuml-extension/` in VS Code and press **F5**. That launches an
Extension Development Host; run **PlantUML: Open Interactive Diagram** from the
command palette with a `.puml` file open.

`.vscode/launch.json` already points `PLANTUML_GUI_PYTHON` at `../.venv/bin/python`.
This matters because the Extension Development Host launches *without a
workspace folder*, so workspace-scoped settings are not read at all — during
development, the `env` block in `launch.json` is the reliable knob.

## Generated assets

`media/app`, `media/menus` and `media/vendor` are **generated and gitignored**.
A webview can only load files from inside the extension folder, so
`scripts/sync_assets.py` mirrors the web app's frontend out of
`src/plantuml_gui/` (rendering the Jinja menu partials rather than copying them)
and copies four browser libraries out of `node_modules`.

| When | What runs |
|---|---|
| `npm install` | `postinstall` regenerates `media/` (warns, does not fail, if `uv` is missing) |
| `vsce package` | `vscode:prepublish` regenerates `media/`, and fails if it cannot |
| After editing `src/plantuml_gui/static` or `templates/partials` | run `npm run sync-assets` yourself |

`npm run sync-assets:check` reports whether your `media/` is behind its sources
without writing anything.

## Settings

| Setting | Purpose |
|---|---|
| `plantumlInteractive.plantumlJar` | Absolute path to `plantuml.jar`. Defaults to a shared install path; set it yourself, or clear it to fall back to `PLANTUML_JAR`. |
| `plantumlInteractive.pythonPath` | Interpreter that has `plantuml-gui` installed. Required — nothing is guessed. Falls back to `PLANTUML_GUI_PYTHON`. |

## Development

```bash
npm run lint     # eslint
npm test         # downloads a VS Code build on first run, then runs test/
```

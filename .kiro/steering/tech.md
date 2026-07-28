# Technology Stack

## Backend

- **Python**: 3.10+ required
- **Flask**: 3.x web framework with Jinja2 templates
- **python-dotenv**: Environment variable management
- **loguru**: Logging
- **pyquery**: HTML/XML parsing for SVG manipulation

## Frontend

- **Vanilla JavaScript**: No framework dependencies
- **Ace Editor**: Code editor with PlantUML syntax highlighting (custom mode in `mode-plantuml.js`)
- **CSS**: Plain CSS, no preprocessors

## External Dependencies

- **PlantUML JAR**: Required for diagram rendering. Path configured via `PLANTUML_JAR` environment variable in `.env` file

## Build & Packaging

- **Hatchling**: Build backend
- **uv**: Package manager and virtual environment tool

## Development Tools

- **ruff**: Linting and formatting (rules: E, F, I, N; E501 ignored)
- **mypy**: Static type checking
- **pre-commit**: Git hooks for code quality
- **js-beautify**: JavaScript formatting (for script.js)

## Testing

- **pytest**: Python unit tests with pytest-cov for coverage
- **pytest-playwright**: End-to-end browser tests for JavaScript logic and UI interactions

## Commands

```bash
# Install dependencies
uv sync

# Run server
uv run python -m plantuml_gui

# Run Python tests
uv run pytest

# Run tests with coverage
uv run python -m pytest --cov --cov-report=html

# Setup pre-commit hooks
uv run pre-commit install -t pre-commit -t pre-push
```

## VS Code Extension

The `plantuml-extension/` sub-project is a Node/VS Code extension that reuses the
web app frontend inside a webview and runs the Flask backend as a child process
(`src/plantuml_gui/serve.py`).

- **Node.js**: 22 (per CI); **VS Code**: `^1.125.0`
- **Testing**: `@vscode/test-cli` / `@vscode/test-electron` (drives a real VS Code; needs a display, `xvfb` in CI)
- **Linting**: ESLint flat config (`eslint.config.mjs`), ignoring the generated `media/app` and `media/vendor`
- **Asset mirror**: `scripts/sync_assets.py` (run via `scripts/sync-assets.mjs`) mirrors `src/plantuml_gui/static`, the Jinja-rendered menu partials, and vendored libraries into `media/`; needs `jinja2`
- **Vendored libs**: bootstrap, jquery, panzoom, diff (copied into `media/vendor` by the sync script)

Commands (from `plantuml-extension/`):

```bash
npm ci                     # install
npm run sync-assets        # regenerate the mirrored frontend
npm run sync-assets:check  # fail if the mirror is stale (CI)
npm run lint               # eslint
npm test                   # @vscode/test-cli (needs a display)
```

CI: `.github/workflows/extension.yml` runs the mirror check, lint, and tests on
push/PR to `main`/`summer`.

## Constraints

- All Python code must pass ruff and mypy checks
- MIT license headers required in source files
- PlantUML JAR must be available locally (not bundled)

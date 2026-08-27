# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0]

### Added

- Managed local Jupyter runtime. The backend module detects Python, offers a guided install of the Jupyter stack, and spawns a token-secured loopback server rooted in the workspace. Editors hold renewable leases and the server idles down after the last one expires.
- Runtime setup panel for Python detection, install, and kernel choice, with a confirm dialog on destructive kernel actions. Includes an escape hatch for connecting to a loopback server you started yourself.
- `jupyter.create_notebook`, so an agent can start an analysis without hand-writing nbformat JSON that loses cell IDs and kernelspec metadata.
- `jupyter.get_runtime_info`, reporting interpreter path, version, virtualenv or conda environment, cwd, and optional per-package importability in one round trip.
- AI tools for cell CRUD, execution with timeouts and interrupt, kernel variable introspection, and DataFrame previews.
- Cell staleness flags, so agents can tell which cells need re-running.
- A single slim notebook toolbar replacing the stock JupyterLab toolbars.

### Changed

- `jupyter.run_all` returns a per-cell status summary rather than every output, with the first failure expanded inline and its traceback stripped of ANSI. Full snapshots remain available via `includeOutputs`. Whole-notebook output on the most common agent call was a context bomb.
- `run_all` outcomes now key off what the cells show rather than `NotebookActions.runAll`'s return flag, which reported failure when a cell raised and success when no kernel had attached.
- `CellOutputSnapshot` carries `cellType`, distinguishing a code cell that never ran from a markdown cell.
- Notebook chrome follows the host theme.
- The 13 MB renderer sourcemap is excluded from the published build, behind `NIMBALYST_EXT_SOURCEMAP=1` and the `build:debug` script.

### Fixed

- Orphaned Jupyter servers. `deactivate()` was the only path that stopped a managed server, so any teardown the backend did not observe left `jupyter-server` reparented to init and running forever, accumulating one leak per app run. Three layers now guard it: process teardown hooks, a pid registry reclaimed on next launch (matching the recorded token against the live command line so a recycled pid is never signalled), and Jupyter's own idle-server and idle-kernel culling as a backstop.

### Security

- Pinned the six bundled packages that parse untrusted notebook content past known advisories. `sanitize-html` let `javascript:` URIs through, which an `.ipynb`'s saved HTML output could reach. Production audit went from 30 findings to 0.
- `manualServerUrl` is validated against the loopback rule. The setting is workspace-scoped and so arrives with the workspace; a rejected URL now fails closed and visibly instead of appearing to take effect.
- Dropped `allowTokenless` and `token` from the `ensure_server` MCP schema; they are ignored unless `NIMBALYST_JUPYTER_DEV_UNSAFE_SERVER=1`. They could start a local Jupyter with absent or caller-chosen authentication.
- Every `editor-write` AI tool is refused on a read-only notebook. `NotebookModel`'s `readOnly` flag does not stop `sharedModel` writes or execution on its own. `jupyter.execute` stays available, since it never writes to the notebook.
- Removed a README setup recipe that disabled XSRF checks and allowed any origin.

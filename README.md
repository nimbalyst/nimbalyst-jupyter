# Nimbalyst Jupyter Extension

A Jupyter notebook editor for [Nimbalyst](https://nimbalyst.com). Open, edit, and run
`.ipynb` files in a first-class notebook editor backed by
[`@jupyterlab/notebook`](https://www.npmjs.com/package/@jupyterlab/notebook), with
real execution through a local `jupyter_server` managed by the extension backend.

## Features

- Real cell execution through managed local Jupyter kernels
- Detect/install flow for Python, `jupyter_server`, `ipykernel`, and `ipywidgets`
- Kernel picker, live status, interrupt, reconnect, restart, run-all/above/below
- Core Jupyter MIME rendering (HTML, images, LaTeX, errors) and core ipywidgets controls
- Kernel-backed Tab completion and Shift+Tab inspection
- `nbformat` round-trip that preserves cell IDs and metadata
- AI tools for compact notebook projection, live cell listing, output inspection,
  cell edits, insertion, and kernel-backed execution
- Backend MCP tools for starting, stopping, checking, and listing kernels from the
  managed local Jupyter server

## Getting a kernel

On first use, the editor asks Nimbalyst to grant its local runtime backend. It
detects workspace virtual environments, active virtualenv/conda environments,
pyenv, PATH, and common system Python locations. If Python is present without
Jupyter, the inline setup panel offers **Install Jupyter**. The install runs:

```bash
python3 -m pip install jupyter_server jupyter-client ipykernel ipywidgets
```

The runtime requires a local Python 3. Remote Jupyter servers are rejected. A Pyodide
fallback is not shipped, because the host does not yet provide the worker/wheel asset
pipeline that `@jupyterlite/pyodide-kernel` requires.

### Security posture

The managed server binds only to `127.0.0.1`, uses a random port and a random token,
is rooted inside the workspace, stays alive while mounted editors renew leases, shuts
down 30 minutes after the last lease expires, and is terminated when the backend
module stops.

If you point the extension at a server you started yourself, only loopback URLs are
accepted, and a non-loopback URL is refused with a visible error rather than silently
ignored. The URL may be stored as workspace configuration; the token is kept only for
the current renderer session and never written to configuration storage.

When a notebook is open read-only, the AI tools refuse to edit or execute it.
`jupyter.execute` remains available, since it runs code against the kernel without
writing to the notebook.

### Using a server you started

Expand **Connect to a server I started** in the notebook Runtime panel, or set the
`manualServerUrl` workspace setting. If the server's root is not the workspace root,
also fill in the server root field (or `manualServerRoot`) so kernels start in the
notebook's own directory; without a known root the extension falls back to the server
root as the working directory.

Start such a server with authentication enabled, and let the extension hold the token
for the session:

```bash
jupyter server --no-browser --ip=127.0.0.1 --port=8889 \
  --ServerApp.root_dir="$PWD"
```

## Development

```bash
npm install        # install deps (uses the published @nimbalyst/extension-sdk)
npm run build      # bundle to dist/
npm run build:debug # same, plus the renderer sourcemap
npm run dev        # rebuild on change
npm run typecheck
npm test
```

The renderer sourcemap is ~13MB and is excluded from the published build; use
`build:debug` or `NIMBALYST_EXT_SOURCEMAP=1` when you need it.

In dev builds, backend modules require Nimbalyst to launch with
`NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1`. Without it, start a local server and use
**Connect to a server I started** in the inline setup panel.

`NIMBALYST_JUPYTER_DEV_UNSAFE_SERVER=1` re-enables the `allowTokenless` and explicit
`token` parameters on `ensure_server`. These start a Jupyter server with absent or
caller-chosen authentication, which is arbitrary code execution for anything else on
the machine. Use it only against a throwaway workspace.

To hot-reload into a running Nimbalyst dev instance, use the extension-dev MCP tools
(`extension_reload` / `extension_install`) pointed at this directory's `dist/`.

## Demo notebook

Open [`examples/nimbalyst-integration-demo.ipynb`](./examples/nimbalyst-integration-demo.ipynb)
inside Nimbalyst to exercise the extension's notebook custom editor, registered
`.ipynb` file icon, rich MIME output rendering, and Jupyter AI tools.

## Releasing

Published to the Nimbalyst extension CDN via the monorepo's `/release-extension`
flow. This repo is registered in `packages/marketplace/release-extensions.txt` with
`|skip-build`, so it is built and published from its own checkout.

## License

MIT — see [LICENSE](./LICENSE).

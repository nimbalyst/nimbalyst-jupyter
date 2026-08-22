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

## Development

```bash
npm install       # install deps (uses the published @nimbalyst/extension-sdk)
npm run build     # bundle to dist/
npm run dev       # rebuild on change
npm run typecheck
npm test
```

On first use, the editor asks Nimbalyst to grant its local runtime backend. It
detects workspace virtual environments, active virtualenv/conda environments,
pyenv, PATH, and common system Python locations. If Python is present without
Jupyter, the inline setup panel offers **Install Jupyter**. The install runs:

```bash
python3 -m pip install jupyter_server jupyter-client ipykernel ipywidgets
```

The managed server binds only to `127.0.0.1`, uses a random port and random token,
is scoped to the workspace, stays alive while mounted editors renew leases, shuts
down 30 minutes after the last lease expires, and is terminated when the backend
module stops.

In dev builds, backend modules require Nimbalyst to launch with
`NIMBALYST_ALLOW_DEV_BACKEND_MODULES=1`. If that is unavailable, start a local
server and use **Connect to a server I started** in the inline setup panel. Only
loopback URLs are accepted. The URL may be stored as workspace configuration;
the token is kept only for the current renderer session.

For the legacy DevTools escape hatch, start a server:

```bash
jupyter server --no-browser --ip=127.0.0.1 --port=8889 \
  --ServerApp.root_dir="$PWD" \
  --IdentityProvider.token="" \
  --ServerApp.password= \
  --ServerApp.disable_check_xsrf=True \
  --ServerApp.allow_origin='*'
```

Then set this in Nimbalyst renderer DevTools (development only):

```js
localStorage.setItem(
  'nimbalyst.jupyter.devServer',
  JSON.stringify({ baseUrl: 'http://127.0.0.1:8889', token: '' }),
);
```

If the server root is the workspace and notebooks should start kernels in their
own directories, include `rootDir: '/absolute/path/to/workspace'` in that object.
The Runtime panel exposes the same optional **Server root** field for manually
started servers. Without a known root, the extension safely uses the server root
as the kernel working directory.

The runtime currently requires local Python. The planned Pyodide fallback is not
shipped because the host does not yet provide the worker/wheel asset pipeline that
`@jupyterlite/pyodide-kernel` requires. Remote Jupyter servers are also intentionally
rejected in v1.

To hot-reload into a running Nimbalyst dev instance, use the extension-dev MCP tools
(`extension_reload` / `extension_install`) pointed at this directory's `dist/`.

## Demo notebook

Open [`examples/nimbalyst-integration-demo.ipynb`](./examples/nimbalyst-integration-demo.ipynb)
inside Nimbalyst to exercise the extension's notebook custom editor, registered
`.ipynb` file icon, rich MIME output rendering, and
Jupyter AI tools.

## Releasing

Published to the Nimbalyst extension CDN via the monorepo's `/release-extension`
flow. This repo is registered in `packages/marketplace/release-extensions.txt` with
`|skip-build`, so it is built and published from its own checkout.

## License

MIT — see [LICENSE](./LICENSE).

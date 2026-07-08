# Nimbalyst Jupyter Extension

A Jupyter notebook editor for [Nimbalyst](https://nimbalyst.com). Open, edit, and run
`.ipynb` files in a first-class notebook editor backed by
[`@jupyterlab/notebook`](https://www.npmjs.com/package/@jupyterlab/notebook), with
in-process [Pyodide](https://pyodide.org) kernel execution — no local Python install
required.

## Features

- Real cell execution via an in-process Pyodide kernel, zero install
- JupyterLab-grade mime rendering (HTML, images, LaTeX, errors, ipywidgets)
- `nbformat` round-trip that preserves cell IDs and metadata
- AI tool (`jupyter.get_notebook_projection`) exposing a compact notebook projection
  that hides large outputs by default

## Development

```bash
npm install       # install deps (uses the published @nimbalyst/extension-sdk)
npm run build     # bundle to dist/
npm run dev       # rebuild on change
npm run typecheck
npm test
```

To hot-reload into a running Nimbalyst dev instance, use the extension-dev MCP tools
(`extension_reload` / `extension_install`) pointed at this directory's `dist/`.

## Releasing

Published to the Nimbalyst extension CDN via the monorepo's `/release-extension`
flow. This repo is registered in `packages/marketplace/release-extensions.txt` with
`|skip-build`, so it is built and published from its own checkout.

## License

MIT — see [LICENSE](./LICENSE).

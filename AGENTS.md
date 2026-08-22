# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## What this is

A **Nimbalyst extension** (not a standalone app) that contributes a custom `.ipynb`
editor. Nimbalyst is the host; this bundle is loaded into it. Everything the host
provides — the editor host API, AI tool context, filesystem, React itself — comes in
at runtime and is marked `external` in the Vite build. The contract with the host is
`@nimbalyst/extension-sdk` (a devDependency; types + the `useEditorLifecycle` hook).

## Commands

```bash
npm run build      # vite build -> dist/ (index.js + index.css + sourcemaps)
npm run typecheck  # tsc --noEmit (strict; noUnusedLocals/Parameters on)
npm test           # vitest run
npm run test:watch # vitest watch
npx vitest run tests/notebookProjection.test.ts   # single test file
```

- **Never run `npm run dev` yourself** — the user runs the watch build.
- To load changes into a running Nimbalyst dev instance, use the extension-dev MCP
  tools (`extension_reload` / `extension_install`) pointed at this repo's `dist/`.
- Do not release; publishing happens from the monorepo's `/release-extension` flow.

## How the extension plugs into the host

`manifest.json` is the source of truth for what the host wires up (it is declarative —
`activate()`/`deactivate()` in `src/index.tsx` are intentionally empty):

- `contributions.customEditors` maps `*.ipynb` to the `JupyterNotebookEditor` component
  exported from `src/index.tsx`'s `components` map.
- `contributions.aiTools` lists `jupyter.get_notebook_projection`, whose handler lives
  in `src/aiTools.ts`.
- `permissions.ai` is `false`; `permissions.filesystem` is `true`.

Keep `version` in sync across `manifest.json` and `package.json`.

## Architecture

Two distinct surfaces read/write a notebook, and they must not be conflated:

1. **Live editor** (`src/components/JupyterNotebookEditor.tsx`) — a JupyterLab
   `Notebook` Lumino widget mounted bare (no `NotebookPanel`) inside React via
   `Widget.attach`. Lifecycle (load/save/dirty/theme/read-only) is delegated entirely
   to the SDK's `useEditorLifecycle` hook through `applyContent` / `getCurrentContent`
   callbacks — content state lives in the widget/model, never in React state.
  - `src/services/buildNotebook.ts` constructs the `Notebook` + `NotebookModel` +
     CodeMirror content factory + rendermime. Factories are cached module-level and
     shared across editor instances.
  - `src/services/notebookSerializer.ts` is the pure parse/serialize pair (1-space
     indent + trailing newline to match `nbconvert`/JupyterLab on-disk formatting).
     Kept DOM-free so it's importable from Node tests.

2. **AI-facing views:**
  - When the editor is open, `src/editorApi.ts` (`createEditorAPI`) is registered via
     `host.registerEditorAPI` and gives cell-level AI tools thin read/write access to
     the live `NotebookModel`.
  - When the editor is closed, AI tools fall back to disk via
     `src/services/notebookProjection.ts` — a self-contained parser that emits a
     compact text projection with cell sources verbatim but outputs replaced by short
     MIME-aware placeholders (`[stdout hidden: N lines]`, `[image/png hidden: N chars]`).
     This is what `jupyter.get_notebook_projection` returns; it exists so notebook
     output blobs don't burn the agent's token budget.

**Kernel execution** (`src/services/sessionContext.ts`) — `SessionContextManager` wraps
JupyterLab's `SessionContext` and exposes run/interrupt/restart/clear plus a status
signal for `KernelToolbar`. The kernel is reached through a `ServiceManager`
(`src/services/serviceManagers.ts`).

### Important gotchas

- **Kernel source ≠ what the docs say.** `README.md` / `manifest.json` marketing copy
  describe an "in-process Pyodide kernel, zero install." The code does **not** do that
  yet: `createLocalServiceManager` talks to a user-started `jupyter_server`, read from
  the renderer global `window.__NIMBALYST_JUPYTER_DEV_SERVER__ = { baseUrl, token }`
  (see `readDevServerConfig`). With no config, the editor renders in edit-only mode and
  the toolbar shows a kernel-unavailable notice. Pyodide / main-process managed server
  are labeled future phases in the code comments. Don't assume Pyodide when debugging
  execution.
- `editorApi.ts` intentionally omits `runCells` — cell execution is only added once a
  `SessionContext` is attached. Don't add a kernel-less run path to the editor API.
- Shift+Enter / Ctrl(Cmd)+Enter are captured manually on the Notebook DOM node
  (`attachKernelShortcuts`) because there's no JupyterLab app shell / CommandRegistry
  here to fire the default run commands.
- Theming (`src/services/theme.ts`) is a minimal reconstruction that toggles
  `data-jp-theme-*` attributes; the comment flags it as fragile if theming regresses.

## Build/bundle constraints

- Single ES bundle via `vite.config.ts` lib mode, `inlineDynamicImports: true`, all CSS
  emitted to `index.css`. A `process` shim is injected as a banner for browser runtime.
- Externals: `react`, `react-dom`, `react/jsx-runtime`, `@nimbalyst/runtime` (pattern),
  `@nimbalyst/editor-context`. These are provided by the host — never bundle them.

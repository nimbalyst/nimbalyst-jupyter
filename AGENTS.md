# AGENTS.md

Guidance for AI agents working in this repository. `CLAUDE.md` imports this file, so
edit here and both stay in sync.

## What this is

A **Nimbalyst extension** (not a standalone app) that contributes a custom `.ipynb`
editor. Nimbalyst is the host; this bundle is loaded into it. Everything the host
provides — the editor host API, AI tool context, filesystem, React itself — comes in
at runtime and is marked `external` in the Vite build. The contract with the host is
`@nimbalyst/extension-sdk` (a devDependency; types + the `useEditorLifecycle` hook).

## Commands

```bash
npm run build      # renderer + backend -> dist/ (index.js, index.css, backend.js)
npm run build:debug # same, but emits the renderer sourcemap
npm run typecheck  # tsc --noEmit (strict; noUnusedLocals/Parameters on)
npm test           # vitest run tests
npm run test:watch # vitest watch
npx vitest run tests/notebookProjection.test.ts   # single test file
```

- **Never run `npm run dev` yourself** — the user runs the watch build.
- To load changes into a running Nimbalyst dev instance, use the extension-dev MCP
  tools (`extension_reload` / `extension_install`) pointed at this repo's `dist/`.
- Do not release; publishing happens from the monorepo's `/release-extension` flow.
- Live host E2E lives in `e2e/*.spec.ts` and runs only through the extension-dev MCP
  tool (`extension_test_run({ testFile })`) against the user's running Nimbalyst
  window — never through `npm`, and never as part of `npm test`. It asserts against
  the built `dist/`, so build and reload before trusting a result. `e2e/README.md`
  explains the CommonJS scoping that makes the host's Playwright resolvable, and the
  rules these unsandboxed tests follow.

## How the extension plugs into the host

`manifest.json` is the source of truth for what the host wires up (it is declarative —
`activate()`/`deactivate()` in `src/index.tsx` are intentionally empty):

- `contributions.customEditors` maps `*.ipynb` to the `JupyterNotebookEditor` component
  exported from `src/index.tsx`'s `components` map, and declares collaboration support.
- `contributions.aiTools` lists 20 `jupyter.*` tools (projection, notebook creation,
  cell CRUD, execution with timeouts, transient execute, kernel introspection and
  runtime identity, interrupt/restart); all handlers live in `src/aiTools.ts`.
- `contributions.backendModules` declares `jupyter-runtime` (`dist/backend.js`, a
  utility process holding `mcp-server-register`). It is **disabled by default** and
  prompts on first use.
- `contributions.configuration` exposes `manualServerUrl`, `manualServerRoot`, and
  `pythonPath`, all workspace-scoped.
- Both `permissions.ai` and `permissions.filesystem` are `true`.

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
  - `src/services/notebookCollaboration.ts` and `notebookCollabBinding.ts` bind the
     model to the host's collaborative session when one is present. When
     `host.collaboration` is set, the editor does **not** call `model.fromJSON` on
     reapply and does not drive `setDirty` — the host owns both.

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
signal for the toolbar. The kernel is reached through a `ServiceManager`
(`src/services/serviceManagers.ts`).

### Where the kernel actually comes from

There is no Pyodide kernel. `resolveServerConfig()` in `src/services/serviceManagers.ts`
picks a local `jupyter_server` in this order:

1. **manual** — `manualServerUrl` workspace configuration, or a session-only config set
   through the Runtime panel. Tokens for manual servers live in memory for the renderer
   session and never reach configuration storage.
2. **dev** — `window.__NIMBALYST_JUPYTER_DEV_SERVER__` or the matching localStorage key.
3. **managed** — `jupyter.acquire_server` on the backend module, which spawns and leases
   a server.

Every path is validated by `assertLoopbackServerConfig`; remote servers are rejected
outright. With no usable source the editor renders edit-only and `RuntimeSetupPanel`
explains why.

`src/backend.ts` (utility process) owns the managed server: it detects Python
(`buildPythonCandidates` covers workspace `.venv`, `VIRTUAL_ENV`, `CONDA_PREFIX`, pyenv,
PATH, and common system paths), can `pip install` the Jupyter stack, and spawns
`jupyter server` bound to `127.0.0.1` on a random port with a random token, rooted
inside the workspace. Editors hold renewable leases; the server idles down 30 minutes
after the last lease expires and is killed on `deactivate`.

### Security invariants — do not regress these

- **Loopback only.** `assertLoopbackServerConfig` gates every server config, including
  the one read from workspace configuration. Workspace settings arrive with the
  workspace and are not trusted; a rejected `manualServerUrl` fails closed with a
  visible error rather than silently falling back to the managed server.
- **`resolveWorkspaceRoot`** keeps the server root inside the active workspace.
- **`allowTokenless` and explicit `token`** are absent from the `ensure_server` MCP
  schema and ignored unless `NIMBALYST_JUPYTER_DEV_UNSAFE_SERVER=1`. They would let a
  caller stand up a local Jupyter with no or attacker-known auth, which is arbitrary
  code execution for anything else on the machine. See `resolveServerToken`.
- **Read-only is enforced on the AI path.** `requireWritableJupyterEditorAPI` in
  `src/aiTools.ts` refuses every tool whose `access.kind` is `editor-write`, and
  `createEditorAPI` guards the same methods as a backstop. `NotebookModel.readOnly`
  alone does *not* stop `sharedModel` writes or kernel execution. `jupyter.execute` is
  deliberately `editor-read` and stays available, since it never writes to the
  notebook. If you add a mutating tool, mark it `editor-write` and use the writable
  guard — `tests/aiTools.test.ts` asserts the exact list.
- **`overrides` in `package.json`** pin `sanitize-html`, `mermaid`, `dompurify`,
  `postcss`, `nanoid`, and `fast-uri` past known advisories. All six are bundled into
  `dist/index.js` and process untrusted notebook content. Don't drop them; `npm audit
  --omit=dev` should stay at zero.

### Important gotchas

- `jupyter.run_all` returns a per-cell status summary by default, not outputs.
  Full snapshots of a large notebook are a context bomb, so outputs are opt-in via
  `includeOutputs`; the first failing cell is expanded inline (`firstError`, with a
  truncated traceback) because that is the one an agent acts on.
- `src/services/notebookTemplate.ts` is the only place that builds nbformat by hand.
  `jupyter.create_notebook` writes a file that has no live model yet; every other
  write still goes through `NotebookModel` so the human sees it.
- Execution tool timeouts do NOT stop the kernel. `run_cell`/`run_all`/`execute`
  return `timedOut`/partial outputs while the code keeps running; `jupyter.interrupt`
  is the only remedy. `getExecutionStatus()` polls the in-flight registry kept in
  `editorApi.ts`.
- Introspection tools (`list_variables` etc.) are canned Python snippets built in
  `src/services/kernelIntrospection.ts`, run through the transient `executeCode`
  path (`store_history=false`). Keep snippets side-effect-free and printing a
  single JSON line to stdout — the parser scans for the last JSON-looking line.
- Staleness flags in `list_cells` come from `src/services/stalenessTracker.ts`,
  which listens to the static `NotebookActions.executed` signal. Flags are
  per-editor-session; `null` means "ran in a previous session, unknowable".
- Binary output export (`get_cell_output includeImages`) goes through the backend
  module (`jupyter.save_output_asset`) because the SDK filesystem service is
  string-only. Backend changes need an extension disable/enable (or app restart)
  to re-register MCP tools — `extension_reload` alone is not enough.
- Shift+Enter / Ctrl(Cmd)+Enter are captured manually on the Notebook DOM node
  (`attachKernelShortcuts`) because there's no JupyterLab app shell / CommandRegistry
  here to fire the default run commands.
- Theming (`src/services/theme.ts`) is a minimal reconstruction that toggles
  `data-jp-theme-*` attributes; the comment flags it as fragile if theming regresses.
- Completion (`src/services/completer.ts`) and ipywidgets (`src/widgets/ipywidgets.ts`)
  are both wired without a JupyterLab app shell, so they hang off the bare `Notebook`
  widget rather than a plugin registry.

## Build/bundle constraints

- Single ES bundle via `vite.config.ts` lib mode, `inlineDynamicImports: true`, all CSS
  emitted to `index.css`. A `process` shim is injected as a banner for browser runtime.
- The externals list comes from the SDK's `createExtensionConfig`, not a hand-written
  array. It covers React *and* yjs / y-protocols / Lexical — bundling a second `Y.Doc`
  breaks the host's `instanceof` checks. Never hand-maintain this list.
- The renderer sourcemap (~13MB) is off by default and is not published. Use
  `npm run build:debug` or `NIMBALYST_EXT_SOURCEMAP=1` when you need it. The much
  smaller `backend.js.map` always ships.
- `vite.backend.config.ts` builds `src/backend.ts` for node20 with builtins external
  and `emptyOutDir: false`, so it must run after the renderer build.

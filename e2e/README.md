# Live-host E2E suite

Playwright specs that drive **the running Nimbalyst app** — the one you have open — over CDP. No second Electron instance is launched; the tests attach to the real window, the real extension bundle in `dist/`, and the real filesystem.

This is the third test layer:

| Layer | Command | Covers |
| --- | --- | --- |
| Unit | `npm test` | Serializers, projection, cell actions, session context |
| Backend integration | `npm run test:integration` | Real backend + real Jupyter Server |
| **Live host (here)** | `extension_test_run` MCP tool | The mounted editor, toolbars, AI tools, host lifecycle |

## Running

Requires Nimbalyst running in dev mode (which is what exposes CDP on port 9222) with this project open as the workspace. The user starts that; never run `npm run dev` yourself.

Run a spec with the extension-dev MCP tool:

```
extension_test_run({ testFile: "/absolute/path/to/nimbalyst-jupyter/e2e/notebookEditor.spec.ts" })
```

There is no `npm` script on purpose. Playwright is not a dependency of this repo — the specs deliberately borrow the host's installation (see below), so `npx playwright test` here would either fail to resolve or install a second, conflicting copy.

Build first if you changed `src/`: the specs assert against `dist/`, so run `npm run build` and `extension_reload` before trusting a result.

## Files

- `hostFixture.ts` — CDP fixture: attaches to the window whose workspace contains these files, plus `extensionEditor` / `callExtensionTool` / `listExtensionTools`.
- `helpers.ts` — notebook fixtures, open/close, locators, disk reads.
- `notebookEditor.spec.ts` — mounted editor, cell toolbar, autosave, close/reopen.
- `notebookAiTools.spec.ts` — `jupyter.*` tool registration, disk projection, live-editor edits.
- `notebookKernel.spec.ts` — kernel toolbar and runtime panel; execution tests skip when no runtime is configured.
- `.tmp/` — disposable notebooks written by the specs (gitignored).

## Why `package.json` here says `type: commonjs`

The host runner shares its own Playwright with external extension projects by setting `NODE_PATH`. Node ignores `NODE_PATH` for ESM, and this repo's root `package.json` is `type: module` — so an ESM spec cannot resolve `@playwright/test` at all. That is the "second Playwright resolution" problem recorded as a blocker in the roadmap.

Scoping this directory to CommonJS makes the `require()` chain honor `NODE_PATH`, so the specs load the *same* Playwright instance as the runner. That is also why `hostFixture.ts` mirrors `@nimbalyst/extension-sdk/testing` instead of importing it: the SDK ships that entry as ESM with only an `import` condition.

Do not add dependencies to `e2e/package.json`. It exists only to set the module type.

## Rules for writing tests here

These tests are **not sandboxed**. They can modify the user's real app and filesystem.

1. **Only touch notebooks you created** under `.tmp/`, via `writeTempNotebook`.
2. **Give every test its own fixture path** (`fixtureNameFor(testInfo.title)`). Reusing one path means deleting and recreating it between tests, and the host's file watcher will deliver that delete to the *next* test's editor, resetting its model to a single empty cell mid-assertion.
3. **Close every tab you open** in `afterEach`, or you leave clutter in the user's window.
4. **Run serially** (`test.describe.configure({ mode: 'serial' })`). There is one app and one active tab.
5. **Accept dialogs explicitly** when exercising Delete or Clear All. Playwright dismisses dialogs by default, silently turning those actions into no-ops.
6. **Assert the model, not only the DOM.** The notebook is a windowed panel; use `expectCellCount` (generous timeout) for rendered counts and `liveEditorCells` for structure.
7. **Prefer polling for disk state.** The host autosaves on a short debounce, so `expect.poll` on `readNotebookFromDisk` — never a bare read.
8. **Always open through `openNotebook`.** Opening a path that already has a tab only *focuses* it; the host does not re-read the file. A tab left behind by an interrupted run would then serve stale content for the rest of the session — and a tab whose file was deleted underneath it renders as a single empty cell, which is a confusing way to learn this. `openNotebook` closes first for exactly that reason.

## Known limits of this harness

- `callExtensionTool` goes through the renderer tool bridge, which runs the tool **handler only**. It does not mount hidden editors for closed files and does not persist the editor afterwards — both are the MCP wrapper's job. So specs assert that tools mutate the live notebook; disk persistence for tool-driven edits is covered through the MCP path by hand, not here.
- Execution tests need a configured Jupyter runtime. Without one they skip with an explicit reason rather than passing vacuously. If they skip unexpectedly, check `localStorage["nimbalyst.jupyter.devServer"]` in the renderer — a stale dev override there silently wins over the managed runtime, so the editor points at whatever endpoint it names and never reports that it cannot reach it.
- `npm run typecheck` does not cover this directory (`tsconfig.json` includes `src` and `tests`). Adding it would require a local Playwright install, which is exactly what the CommonJS arrangement avoids.

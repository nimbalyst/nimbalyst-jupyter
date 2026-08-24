/**
 * Live-host coverage for the `jupyter.*` AI tools.
 *
 * The tools have two distinct backends and both are exercised here:
 *
 * - notebook OPEN  -> the live editor API registered by `host.registerEditorAPI`
 * - notebook CLOSED -> the on-disk projection in `services/notebookProjection.ts`
 *
 * Conflating those two is the mistake this spec exists to catch, so each test
 * states which one it is driving.
 *
 *   extension_test_run({ testFile: "<repo>/e2e/notebookAiTools.spec.ts" })
 */

import { test, expect, callExtensionTool, listExtensionTools } from './hostFixture';
import {
  cellSource,
  cells,
  closeNotebookTab,
  deleteTempNotebook,
  expectCellCount,
  extensionEditorFor,
  fixtureNameFor,
  fixtureNotebook,
  liveEditorCells,
  openNotebook,
  readNotebookFromDisk,
  writeTempNotebook,
} from './helpers';

// The host runner already pins workers to 1, so these never interleave. They are
// deliberately NOT `mode: 'serial'`: each test writes and opens its own notebook,
// so one transient failure (a dev-watch renderer reload, say) must not cascade
// into skipping the rest of the file.

const NOTEBOOK = fixtureNotebook([
  { type: 'markdown', source: '# AI tool fixture' },
  { type: 'code', source: 'total = 1 + 1' },
  {
    type: 'code',
    source: 'print(total)',
    executionCount: 1,
    // A saved output large enough that projecting it verbatim would be wasteful.
    outputs: [
      { output_type: 'stream', name: 'stdout', text: Array.from({ length: 40 }, (_, i) => `line ${i}\n`) },
    ],
  },
]);

let notebookPath: string;

test.beforeEach(async ({}, testInfo) => {
  notebookPath = writeTempNotebook(fixtureNameFor(testInfo.title), NOTEBOOK);
});

test.afterEach(async ({ page }) => {
  await closeNotebookTab(page, notebookPath);
  deleteTempNotebook(notebookPath);
});

test('registers every jupyter tool with the host', async ({ page }) => {
  const tools = await listExtensionTools(page);
  const jupyterTools = tools.map((tool) => tool.name).filter((name) => name.startsWith('jupyter.'));

  // The manifest contributes 20 renderer tools; a drop means a handler failed
  // to register, which the extension itself cannot detect.
  expect(jupyterTools).toHaveLength(20);
  expect(jupyterTools).toEqual(expect.arrayContaining([
    'jupyter.get_notebook_projection',
    'jupyter.create_notebook',
    'jupyter.list_cells',
    'jupyter.insert_cell',
    'jupyter.update_cell_source',
    'jupyter.run_cell',
    'jupyter.get_runtime_info',
    'jupyter.interrupt',
  ]));
});

test('projects a closed notebook from disk with outputs redacted', async ({ page }) => {
  // Notebook is NOT open: this must go through the on-disk projection.
  const result = await callExtensionTool(page, 'jupyter.get_notebook_projection', {
    filePath: notebookPath,
  });

  expect(result.success).toBe(true);
  const projection = JSON.stringify(result.data);

  // Sources come through verbatim...
  expect(projection).toContain('total = 1 + 1');
  expect(projection).toContain('print(total)');
  // ...while the 40-line output is replaced by a placeholder rather than
  // spending the agent's context on it.
  expect(projection).toContain('hidden');
  expect(projection).not.toContain('line 39');
});

test('lists cells from the live editor when the notebook is open', async ({ page }) => {
  const editor = await openNotebook(page, notebookPath);
  await expectCellCount(editor, 3);

  const result = await callExtensionTool(page, 'jupyter.list_cells', { filePath: notebookPath });
  expect(result.success).toBe(true);

  const listed = JSON.stringify(result.data);
  expect(listed).toContain('total = 1 + 1');
  expect(listed).toContain('markdown');
});

/**
 * Scope note for the two tests below: the renderer bridge invokes the tool
 * HANDLER only. Persisting the editor afterwards is the MCP wrapper's job (it
 * is also what mounts a hidden editor for closed files), so these assert that
 * the handler mutates the live notebook -- model and widget together -- and
 * leave the disk round trip to the toolbar-driven tests in notebookEditor.spec.
 */

test('inserts a cell through the tool and shows it in the mounted widget', async ({ page }) => {
  const editor = await openNotebook(page, notebookPath);
  await expectCellCount(editor, 3);

  const result = await callExtensionTool(page, 'jupyter.insert_cell', {
    filePath: notebookPath,
    cellType: 'code',
    source: 'inserted_by_tool = True',
    position: 'end',
  });
  expect(result.success).toBe(true);

  // An AI-driven edit has to land in the widget the user is looking at, not
  // just in a model the UI never re-reads.
  await expectCellCount(editor, 4);
  await expect(cells(editor).nth(3)).toContainText('inserted_by_tool');

  const live = await liveEditorCells(page, notebookPath);
  expect(live.map((cell) => cell.source)).toEqual([
    '# AI tool fixture',
    'total = 1 + 1',
    'print(total)',
    'inserted_by_tool = True',
  ]);
});

test('edits a cell through the tool without disturbing the others', async ({ page }) => {
  const editor = await openNotebook(page, notebookPath);
  await expectCellCount(editor, 3);

  const targetId = readNotebookFromDisk(notebookPath).cells[1].id;
  expect(targetId).toBeTruthy();

  const result = await callExtensionTool(page, 'jupyter.update_cell_source', {
    filePath: notebookPath,
    cellId: targetId,
    source: 'total = 2 + 2',
  });
  expect(result.success).toBe(true);

  await expect(cells(editor).nth(1)).toContainText('total = 2 + 2');

  const live = await liveEditorCells(page, notebookPath);
  expect(live).toHaveLength(3);
  expect(live.map((cell) => cell.source)).toEqual([
    '# AI tool fixture',
    'total = 2 + 2',
    'print(total)',
  ]);
  // Editing by id must not renumber or re-id the surrounding cells.
  expect(live[1].id).toBe(targetId);
});

test('refuses cell writes when no editor is mounted, with an actionable error', async ({ page }) => {
  // The renderer tool bridge these specs use does NOT mount hidden editors --
  // that happens upstream in the MCP path, which supplies `context.editorAPI`.
  // Cell-level tools therefore have to fail loudly here rather than silently
  // no-op, and the message has to tell the caller how to recover.
  const targetId = readNotebookFromDisk(notebookPath).cells[1].id;

  const result = await callExtensionTool(page, 'jupyter.update_cell_source', {
    filePath: notebookPath,
    cellId: targetId,
    source: 'should_not_be_written = True',
  });

  expect(result.success).toBe(false);
  expect(result.error).toMatch(/editor API is unavailable/i);
  expect(result.error).toMatch(/filePath|Open the notebook/i);

  // Crucially, a rejected write must not have touched the file.
  expect(cellSource(readNotebookFromDisk(notebookPath).cells[1])).toBe('total = 1 + 1');
});

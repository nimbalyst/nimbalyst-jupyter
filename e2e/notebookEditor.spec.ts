/**
 * Live-host coverage for the mounted `.ipynb` editor (roadmap QA-02).
 *
 * Run against a running Nimbalyst dev instance with the extension-dev MCP tool:
 *
 *   extension_test_run({ testFile: "<repo>/e2e/notebookEditor.spec.ts" })
 *
 * Deliberately NOT part of `npm test`: these drive the user's real window and
 * real filesystem. See e2e/README.md.
 */

import { test, expect } from './hostFixture';
import {
  acceptConfirm,
  cellExecutionCount,
  cellGutter,
  cellMenuItem,
  cellSource,
  cellToolbar,
  cellToolbarButton,
  cellTypeMenuItem,
  cells,
  closeNotebookTab,
  confirmDialog,
  deleteTempNotebook,
  dismissConfirm,
  expectCellCount,
  extensionEditorFor,
  fixtureNameFor,
  fixtureNotebook,
  hoverCell,
  liveEditorCells,
  moveCellButton,
  notebookToolbar,
  openCellMenu,
  openNotebook,
  openToolbarMenu,
  readNotebookFromDisk,
  toolbarMenuItem,
  writeTempNotebook,
} from './helpers';

// The host runner already pins workers to 1, so these never interleave. They are
// deliberately NOT `mode: 'serial'`: each test writes and opens its own notebook,
// so one transient failure (a dev-watch renderer reload, say) must not cascade
// into skipping the rest of the file.

const MARKDOWN_SOURCE = '# E2E fixture\n\nMounted by the live Playwright suite.';
const NOTEBOOK = fixtureNotebook([
  { type: 'markdown', source: MARKDOWN_SOURCE },
  { type: 'code', source: 'answer = 42\nprint(answer)' },
  { type: 'code', source: 'answer * 2' },
]);
const ORIGINAL_SOURCES = [MARKDOWN_SOURCE, 'answer = 42\nprint(answer)', 'answer * 2'];

let notebookPath: string;

test.beforeEach(async ({ page }, testInfo) => {
  // A fresh path per test: see writeTempNotebook on why reusing one path lets a
  // stale file-watcher event wipe the next test's notebook.
  notebookPath = writeTempNotebook(fixtureNameFor(testInfo.title), NOTEBOOK);
  await openNotebook(page, notebookPath);
});

test.afterEach(async ({ page }) => {
  await closeNotebookTab(page, notebookPath);
  deleteTempNotebook(notebookPath);
});

test('mounts the notebook with one toolbar row and its cells', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  // Exactly one persistent toolbar. The old second row of cell buttons is gone:
  // cell chrome is drawn on the cell, and only for the cell being pointed at.
  await expect(notebookToolbar(editor)).toBeVisible();
  await expect(editor.locator('.jupyter-toolbar')).toHaveCount(1);
  await expectCellCount(editor, 3);
  await expect(editor.locator('.jupyter-cell-toolbar')).toHaveCount(0);

  await hoverCell(editor, 1);
  await expect(cellToolbar(editor, 1)).toBeVisible();
  // ...and it belongs to that cell alone.
  await expect(cellToolbar(editor, 2)).toHaveCount(0);

  // The widget renders what is on disk, in order and with the right cell types.
  await expect(cells(editor).nth(0)).toHaveClass(/jp-MarkdownCell/);
  await expect(cells(editor).nth(1)).toHaveClass(/jp-CodeCell/);
  await expect(cells(editor).nth(2)).toHaveClass(/jp-CodeCell/);

  // ...and the AI-facing editor API describes the same notebook as the widget.
  const live = await liveEditorCells(page, notebookPath);
  expect(live.map((cell) => cell.cellType)).toEqual(['markdown', 'code', 'code']);
  expect(live.map((cell) => cell.source)).toEqual(ORIGINAL_SOURCES);
});

test('inserts a cell from the cell menu and undoes it', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await openCellMenu(editor, 1, 'More cell actions');
  await cellMenuItem(editor, 'Insert cell below').click();
  await expectCellCount(editor, 4);

  // The insert is a real notebook mutation, not just a rendered row.
  let live = await liveEditorCells(page, notebookPath);
  expect(live).toHaveLength(4);
  expect(live[2].source).toBe('');
  expect(live[2].cellType).toBe('code');

  await openToolbarMenu(editor, 'More notebook actions');
  await toolbarMenuItem(editor, 'Undo cell operation').click();
  await expectCellCount(editor, 3);

  // Undo must land exactly on the loaded document, not past it into the
  // empty model the notebook is built from.
  //
  // KNOWN DEFECT (model, not toolbar): the shared model's undo stack still
  // holds the initial `fromJSON` population, so one undo after one insert
  // empties the document instead of reverting the insert. Confirmed against
  // `buildNotebook` in isolation: 2 cells -> insert -> 3 -> undo -> 0. This
  // assertion is the detector for that and is expected to fail until the
  // model stops recording the load as an undoable operation.
  live = await liveEditorCells(page, notebookPath);
  expect(live.map((cell) => cell.source)).toEqual(ORIGINAL_SOURCES);
});

test('duplicates the cell the toolbar is drawn on', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await hoverCell(editor, 1);
  await cellToolbarButton(editor, 1, 'Duplicate cell').click();
  await expectCellCount(editor, 4);

  const live = await liveEditorCells(page, notebookPath);
  expect(live[1].source).toBe('answer = 42\nprint(answer)');
  expect(live[2].source).toBe('answer = 42\nprint(answer)');
  // A duplicate is a new cell, so it must not reuse the source cell's id.
  expect(live[2].id).not.toBe(live[1].id);
});

test('changes cell type from the cell\'s own type menu', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await openCellMenu(editor, 2, 'Cell type: Code');
  await cellTypeMenuItem(editor, 'Markdown').click();

  await expect(cells(editor).nth(2)).toHaveClass(/jp-MarkdownCell/);
  const live = await liveEditorCells(page, notebookPath);
  expect(live[2].cellType).toBe('markdown');
  // Changing type must carry the source over, not reset the cell.
  expect(live[2].source).toBe('answer * 2');
});

test('deletes the pointed-at cell after confirmation', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await hoverCell(editor, 1);
  await cellToolbarButton(editor, 1, 'Delete cell').click();
  // The gate is in-DOM, so the prompt itself is assertable.
  await expect(confirmDialog(editor)).toContainText('Delete this notebook cell?');
  await acceptConfirm(editor, 'Delete');

  await expect(confirmDialog(editor)).toHaveCount(0);
  await expectCellCount(editor, 2);

  const live = await liveEditorCells(page, notebookPath);
  expect(live.map((cell) => cell.source)).toEqual([MARKDOWN_SOURCE, 'answer * 2']);
});

test('keeps the delete when the confirmation is dismissed', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await hoverCell(editor, 1);
  await cellToolbarButton(editor, 1, 'Delete cell').click();
  await dismissConfirm(editor);

  await expect(confirmDialog(editor)).toHaveCount(0);
  await expectCellCount(editor, 3);
  const live = await liveEditorCells(page, notebookPath);
  expect(live.map((cell) => cell.source)).toEqual(ORIGINAL_SOURCES);
});

test('moves a cell and persists the new order to disk', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await hoverCell(editor, 2);
  await moveCellButton(editor, 2, 'up').click();

  const reordered = [MARKDOWN_SOURCE, 'answer * 2', 'answer = 42\nprint(answer)'];
  const live = await liveEditorCells(page, notebookPath);
  expect(live.map((cell) => cell.source)).toEqual(reordered);

  // The host autosaves the dirty editor on a short debounce; the reorder has to
  // reach the file, not just the in-memory model.
  await expect
    .poll(() => readNotebookFromDisk(notebookPath).cells.map(cellSource), {
      timeout: 20000,
      message: 'notebook reorder never reached disk',
    })
    .toEqual(reordered);
});

test('survives a close and reopen with the edit intact', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await openCellMenu(editor, 1, 'More cell actions');
  await cellMenuItem(editor, 'Insert cell below').click();
  await expectCellCount(editor, 4);

  // Wait for the autosave before closing; closing first would test the host's
  // flush-on-unmount instead of the round trip we care about here.
  await expect
    .poll(() => readNotebookFromDisk(notebookPath).cells.length, {
      timeout: 20000,
      message: 'inserted cell never reached disk',
    })
    .toBe(4);

  await closeNotebookTab(page, notebookPath);
  const reopened = await openNotebook(page, notebookPath);

  await expectCellCount(reopened, 4);
  const live = await liveEditorCells(page, notebookPath);
  expect(live).toHaveLength(4);
  expect(live.map((cell) => cell.source)).toEqual([
    MARKDOWN_SOURCE,
    'answer = 42\nprint(answer)',
    '',
    'answer * 2',
  ]);
});

test('confirms destructive actions in the DOM, never with a native dialog', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  // Native dialogs block the renderer, cannot be themed, and look nothing like
  // the rest of the app. Record any that fire so this fails loudly rather than
  // silently reverting to window.confirm.
  const nativeDialogs: string[] = [];
  page.on('dialog', (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });

  await hoverCell(editor, 1);
  await cellToolbarButton(editor, 1, 'Delete cell').click();

  // The prompt is real markup inside the extension's own editor container.
  const dialog = confirmDialog(editor);
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Delete this notebook cell?');
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();

  await dismissConfirm(editor);
  await expect(dialog).toHaveCount(0);
  await expectCellCount(editor, 3);

  // Clear All gates the same way.
  await openToolbarMenu(editor, 'More notebook actions');
  await toolbarMenuItem(editor, 'Clear all outputs').click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Clear every saved cell output?');
  await dismissConfirm(editor);

  expect(nativeDialogs).toEqual([]);
});

// KNOWN DEFECT: markdown cells are flagged `jp-mod-rendered` and get a
// `.jp-RenderedMarkdown` container, but the container holds a single `<pre>` with
// the raw source -- headings, bold, and lists never become elements. HTML outputs
// (DataFrame tables, and the HTML/SVG in examples/nimbalyst-integration-demo)
// render correctly, so rendermime itself works; the markdown renderer is the one
// falling back to plain text. Affects every notebook, including the demos.
test.fail('renders markdown cells as HTML', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  const rendered = cells(editor).nth(0).locator('.jp-RenderedMarkdown');
  await expect(rendered).toBeVisible();
  // `# E2E fixture` must become a heading element, not literal text in a <pre>.
  await expect(rendered.locator('h1')).toHaveText('E2E fixture');
});

test('collapses cell input in the mounted widget', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  await openCellMenu(editor, 1, 'More cell actions');
  await cellMenuItem(editor, 'Collapse input').click();

  await expect(cells(editor).nth(1).locator('.jp-InputArea-editor')).toBeHidden();
});

// KNOWN DEFECT: collapsing input updates the model and serializes correctly,
// but the collapse alone never marks the editor dirty, so the host never
// autosaves it. The state only reaches disk if some later edit triggers a save;
// collapse-then-close silently loses it. `test.fail()` keeps this running and
// will flag loudly once the extension starts marking metadata changes dirty.
test.fail(
  'collapsed input reaches disk on its own',
  async ({ page }) => {
    const editor = extensionEditorFor(page, notebookPath);

    await openCellMenu(editor, 1, 'More cell actions');
    await cellMenuItem(editor, 'Collapse input').click();

    await expect
      .poll(
        () =>
          (
            readNotebookFromDisk(notebookPath).cells[1].metadata as
              | { jupyter?: { source_hidden?: boolean } }
              | undefined
          )?.jupyter?.source_hidden ?? false,
        { timeout: 15000, message: 'collapsed input never reached disk' },
      )
      .toBe(true);
  },
);

test('draws the execution count in the gutter, with run appearing on hover', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  // The fixture's code cells have never run, so the count is the empty
  // placeholder rather than a number -- and the markdown cell has no gutter.
  await expect(cellExecutionCount(editor, 1)).toHaveText('[ ]');
  await expect(cellGutter(editor, 0)).toHaveCount(0);

  // The run button is hover-scoped; the count is not.
  await expect(cellGutter(editor, 2).getByRole('button', { name: 'Run this cell' })).toHaveCount(0);
  await hoverCell(editor, 2);
  await expect(cellGutter(editor, 2).getByRole('button', { name: 'Run this cell' })).toBeVisible();
});

test('drops cell chrome when the pointer moves to another cell', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);

  // Make cell 2 the active one first, so cell 1 is neither active nor hovered
  // once the pointer leaves it and has no reason to keep its chrome.
  await cells(editor).nth(2).click();
  await hoverCell(editor, 1);
  await expect(cellToolbar(editor, 1)).toBeVisible();

  await hoverCell(editor, 2);
  await expect(cellToolbar(editor, 2)).toBeVisible();
  await expect(cellToolbar(editor, 1)).toHaveCount(0);
});

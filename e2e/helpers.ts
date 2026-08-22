/**
 * Shared helpers for the live-host Playwright suite.
 *
 * These specs do NOT launch an Electron instance. They attach over CDP to the
 * Nimbalyst window the user already has open on this workspace, so every
 * assertion is against the real app: the real extension bundle in `dist/`, the
 * real host editor lifecycle, and the real filesystem.
 *
 * Consequences that shape everything below:
 *
 * - Tests are unsandboxed. They must only touch notebooks they created under
 *   `e2e/.tmp/`, and must close every tab they opened.
 * - Tests run one at a time (the host runner pins workers to 1) but stay
 *   independent of each other: each owns its own fixture file and tab.
 * - Fixtures live inside the workspace, not `/tmp`, because the host resolves
 *   editors and extension tools against the open workspace.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, extensionEditor } from './hostFixture';
import type { Locator, Page } from 'playwright';

export const EXTENSION_ID = 'com.nimbalyst.jupyter';

/** Disposable notebooks live here. Gitignored; never point a test at a real file. */
export const TEMP_DIR = join(__dirname, '.tmp');

export interface FixtureCell {
  type: 'code' | 'markdown' | 'raw';
  source: string;
  /** Saved outputs, for cells that should look like they already ran. */
  outputs?: unknown[];
  executionCount?: number | null;
}

/**
 * Build nbformat 4.5 JSON using the same 1-space indent the extension's
 * serializer emits, so a round trip that changes nothing leaves the file
 * byte-identical and "did the editor rewrite this?" stays a meaningful question.
 */
export function fixtureNotebook(cells: FixtureCell[]): string {
  const content = {
    cells: cells.map((cell, index) => {
      const base = {
        cell_type: cell.type,
        id: `e2e-cell-${index}`,
        metadata: {},
        source: splitSource(cell.source),
      };
      if (cell.type !== 'code') return base;
      return {
        ...base,
        execution_count: cell.executionCount ?? null,
        outputs: cell.outputs ?? [],
      };
    }),
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python', version: '3.11.0' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(content, null, 1) + '\n';
}

/** nbformat stores source as a line array with the newlines retained. */
function splitSource(source: string): string[] {
  const lines = source.split('\n');
  return lines.map((line, index) => (index === lines.length - 1 ? line : `${line}\n`));
}

/**
 * Write a disposable notebook into the workspace and return its absolute path.
 *
 * Give every test its own `name`. Reusing one path across tests means deleting
 * and recreating it between them, and the host's file watcher will happily
 * deliver that delete to the next test's freshly mounted editor -- which resets
 * the model to a single empty cell mid-assertion.
 */
export function writeTempNotebook(name: string, contents: string): string {
  mkdirSync(TEMP_DIR, { recursive: true });
  const path = join(TEMP_DIR, `${name}.ipynb`);
  writeFileSync(path, contents, 'utf8');
  return path;
}

/**
 * Filesystem-safe fixture name derived from a test title, made unique per run.
 *
 * The run suffix matters. The host caches a document model per file path, and
 * that cache outlives both the tab and an `extension_reload`. Reusing a path
 * across runs means a later run can be handed the *previous* run's model — and
 * since the previous run deleted its fixture in `afterEach`, that cached model
 * is an empty notebook, which mounts as a single empty cell and fails every
 * assertion. `process.pid` is fresh for each Playwright run, so paths never
 * collide with a model left behind by an earlier one.
 */
export function fixtureNameFor(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  return `${slug}-${process.pid}`;
}

export interface DiskNotebook {
  cells: Array<{
    cell_type: string;
    id?: string;
    source: string[] | string;
    outputs?: unknown[];
    execution_count?: number | null;
    metadata?: Record<string, unknown>;
  }>;
  nbformat: number;
  metadata: Record<string, unknown>;
}

export function readNotebookFromDisk(path: string): DiskNotebook {
  return JSON.parse(readFileSync(path, 'utf8')) as DiskNotebook;
}

/** Cell source as one string, regardless of nbformat's array/string split. */
export function cellSource(cell: { source: string[] | string }): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source;
}

export function deleteTempNotebook(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Open a notebook in a real tab and wait for the extension editor to mount.
 *
 * Uses the host's `__handleWorkspaceFileSelect` -- the same entry point the
 * `extension_test_open_file` MCP tool drives -- rather than clicking the file
 * tree, which would depend on scroll position and folder expansion state.
 */
export async function openNotebook(page: Page, filePath: string): Promise<Locator> {
  // Always start from no tab. Opening a path that is already open just focuses
  // the existing tab -- the host does not re-read the file -- so a tab left
  // behind by an interrupted run would serve stale content for the rest of the
  // session. (A tab whose file was deleted underneath it shows a single empty
  // cell, which is exactly what that looks like when it goes wrong.)
  await closeNotebookTab(page, filePath);
  await requestOpen(page, filePath);

  const editor = extensionEditor(page, EXTENSION_ID, filePath);
  await expect(editor).toBeVisible({ timeout: 20000 });
  // The Lumino widget attaches after React mounts the container, so waiting on
  // the container alone races the first cell query.
  await expect(editor.locator('.jp-Notebook')).toBeVisible({ timeout: 20000 });
  return editor;
}

/**
 * Ask the host to open a file, retrying once through a renderer reload.
 *
 * The suite runs against a dev instance whose watch build can hot-reload the
 * renderer at any moment. That destroys the execution context mid-evaluate and
 * remounts every editor from its initial (empty) model -- which shows up as
 * "Execution context was destroyed" here, or as a notebook that suddenly has one
 * empty cell. One retry after the reload settles is enough; a second failure is
 * a real problem and should surface.
 */
async function requestOpen(page: Page, filePath: string): Promise<void> {
  const open = async () =>
    page.evaluate(async (path) => {
      const handler = (window as unknown as {
        __handleWorkspaceFileSelect?: (p: string) => Promise<void> | void;
      }).__handleWorkspaceFileSelect;
      if (!handler) {
        throw new Error('__handleWorkspaceFileSelect is unavailable; is Nimbalyst running in dev mode?');
      }
      await handler(path);
    }, filePath);

  try {
    await open();
  } catch (error) {
    if (!isContextDestroyed(error)) throw error;
    await page.waitForTimeout(2000);
    await open();
  }
}

function isContextDestroyed(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Target closed|navigation/i.test(message);
}

/**
 * Close the tab for `filePath` if it is open; a no-op when it is not.
 * Stray tabs would pollute the user's real window, so every spec that opens
 * something closes it in `afterEach`.
 */
export async function closeNotebookTab(page: Page, filePath: string): Promise<void> {
  const tab = page.locator(`.tab[title="${filePath}"]`);
  if ((await tab.count()) === 0) return;

  // Close through the DOM rather than a real hover-and-click. The close button
  // only becomes opaque on hover, and the whole tab bar is hidden whenever the
  // user has Nimbalyst in a non-Files mode -- in which case a real click waits
  // for visibility that never arrives, and the tab leaks into the next test.
  await page.evaluate((path) => {
    for (const candidate of Array.from(document.querySelectorAll('.tab'))) {
      if (candidate.getAttribute('title') !== path) continue;
      (candidate.querySelector('.tab-close-button') as HTMLElement | null)?.click();
    }
  }, filePath);

  await expect(page.locator(`.tab[title="${filePath}"]`)).toHaveCount(0, { timeout: 10000 });
}

/** The mounted editor container for a given notebook path. */
export function extensionEditorFor(page: Page, filePath: string): Locator {
  return extensionEditor(page, EXTENSION_ID, filePath);
}

/** Cells currently rendered by the mounted JupyterLab notebook. */
export function cells(editor: Locator): Locator {
  return editor.locator('.jp-Notebook .jp-Cell');
}

/**
 * Assert the rendered cell count with a generous timeout. The notebook is a
 * windowed (virtualized) panel, and a background Nimbalyst window can take
 * noticeably longer than the default 5s to re-render every row after a
 * structural change.
 */
export async function expectCellCount(editor: Locator, count: number): Promise<void> {
  await expect(cells(editor)).toHaveCount(count, { timeout: 20000 });
}

export function notebookToolbar(editor: Locator): Locator {
  return editor.locator('.jupyter-toolbar');
}

/**
 * Reveal one cell's chrome. Every cell-scoped control now lives on the cell and
 * appears only for the cell being pointed at, so a test has to say which cell it
 * means before it can click anything.
 */
export async function hoverCell(editor: Locator, index: number): Promise<Locator> {
  const cell = cells(editor).nth(index);
  await cell.hover();
  const toolbar = cellToolbar(editor, index);
  await toolbar.waitFor({ state: 'visible' });
  return toolbar;
}

/** The hover toolbar drawn on one cell. Not present until that cell is hovered or active. */
export function cellToolbar(editor: Locator, index: number): Locator {
  return cells(editor).nth(index).locator('.jupyter-cell-toolbar');
}

/**
 * A cell-toolbar control by accessible name, e.g. `Duplicate cell`, `Delete
 * cell`. Every one of them is icon-only and carries an `aria-label`, which wins
 * over text content -- so none can be looked up by the glyph it displays.
 */
export function cellToolbarButton(editor: Locator, index: number, name: string): Locator {
  return cellToolbar(editor, index).getByRole('button', { name, exact: true });
}

export function moveCellButton(editor: Locator, index: number, direction: 'up' | 'down'): Locator {
  return cellToolbarButton(editor, index, `Move cell ${direction}`);
}

/** The left gutter: execution count plus the hover run button. Code cells only. */
export function cellGutter(editor: Locator, index: number): Locator {
  return cells(editor).nth(index).locator('.jupyter-cell-gutter');
}

/** A cell's execution count, which doubles as its staleness indicator. */
export function cellExecutionCount(editor: Locator, index: number): Locator {
  return cellGutter(editor, index).locator('.jupyter-cell-gutter__count');
}

/**
 * Open one of a cell's menus (`More cell actions`, or the cell-type button) and
 * return its surface.
 *
 * Unlike the top toolbar's menus, cell menus are portaled to `document.body`:
 * the surface is `position: fixed`, and any `transform` on an ancestor inside
 * the notebook would silently become its containing block. So they are looked
 * up on the page, not inside the editor.
 */
export async function openCellMenu(editor: Locator, index: number, name: string): Promise<Locator> {
  await hoverCell(editor, index);
  await cellToolbarButton(editor, index, name).click();
  const menu = editor.page().locator('[role="menu"]');
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/** A row in whichever cell menu is currently open. */
export function cellMenuItem(editor: Locator, label: string): Locator {
  return editor.page().locator('[role="menu"]').getByRole('menuitem', { name: label, exact: true });
}

/**
 * A cell-type row. These carry `menuitemradio` rather than `menuitem`, because
 * the three types are one exclusive choice, and Playwright's role matching does
 * not treat one as the other.
 */
export function cellTypeMenuItem(editor: Locator, label: string): Locator {
  return editor.page().locator('[role="menu"]').getByRole('menuitemradio', { name: label, exact: true });
}

/** A top-toolbar button by its accessible name, e.g. `Run`, `Restart`. */
export function notebookToolbarButton(editor: Locator, label: string): Locator {
  return notebookToolbar(editor).getByRole('button', { name: label, exact: true });
}

/** The kernel chip: status dot plus kernel identity, and the kernel popover's trigger. */
export function kernelChip(editor: Locator): Locator {
  return editor.getByTestId('jupyter-toolbar-kernel-chip');
}

/**
 * Open a toolbar menu and return its surface. Most of the old bar's buttons now
 * live one click deep, behind `Run options`, `Kernel options`, the chip, or
 * `More notebook actions`.
 */
export async function openToolbarMenu(editor: Locator, triggerName: string): Promise<Locator> {
  await notebookToolbarButton(editor, triggerName).click();
  const menu = editor.locator('[role="menu"]');
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/** A row in whichever toolbar menu is currently open. */
export function toolbarMenuItem(editor: Locator, label: string): Locator {
  return editor.locator('[role="menu"]').getByRole('menuitem', { name: label, exact: true });
}

/**
 * The in-DOM confirmation gate for destructive actions (Delete, Restart, Clear
 * All). It is real markup rather than `window.confirm`, so tests drive it with
 * ordinary locators and can assert on the prompt text.
 */
export function confirmDialog(editor: Locator): Locator {
  return editor.getByTestId('jupyter-confirm-dialog');
}

/** Accept the pending confirmation. `label` defaults to whatever button is not Cancel. */
export function acceptConfirm(editor: Locator, label?: string): Promise<void> {
  const dialog = confirmDialog(editor);
  return label
    ? dialog.getByRole('button', { name: label, exact: true }).click()
    : dialog.locator('.jupyter-confirm__confirm').click();
}

/** Dismiss the pending confirmation, i.e. the user hit Cancel. */
export function dismissConfirm(editor: Locator): Promise<void> {
  return confirmDialog(editor).getByRole('button', { name: 'Cancel', exact: true }).click();
}

export interface LiveCell {
  id: string;
  index: number;
  cellType: 'code' | 'markdown' | 'raw';
  source: string;
}

/**
 * Read the live editor's cells through the extension's own editor API -- the
 * object `host.registerEditorAPI` hands the AI tools. Asserting on this proves
 * the AI-facing view and the mounted widget describe the same notebook.
 */
export async function liveEditorCells(page: Page, filePath: string): Promise<LiveCell[]> {
  return await page.evaluate(async (path) => {
    const helpers = (window as unknown as {
      __testHelpers?: { getExtensionEditorAPI?: (p: string) => unknown };
    }).__testHelpers;
    const api = helpers?.getExtensionEditorAPI?.(path) as
      | { listCells?: () => LiveCell[] }
      | undefined;
    if (!api?.listCells) throw new Error(`No extension editor API registered for ${path}`);
    return api.listCells();
  }, filePath);
}

/** Kernel status the toolbar is currently reporting, e.g. `idle`, `no-kernel`. */
export async function kernelStatus(editor: Locator): Promise<string> {
  return (await notebookToolbar(editor).getAttribute('data-kernel-status')) ?? 'unknown';
}

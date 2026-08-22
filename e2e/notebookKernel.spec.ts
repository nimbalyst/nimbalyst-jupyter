/**
 * Live-host coverage for the kernel toolbar and the runtime setup panel
 * (roadmap QA-01 / QA-02).
 *
 * Two tiers, because a dev machine may or may not have a Jupyter runtime:
 *
 * - Runtime-independent: the toolbar renders, reports a status, and the runtime
 *   setup panel opens. These always run.
 * - Execution: needs a real kernel. Skipped -- loudly, via the Playwright skip
 *   annotation -- when the toolbar reports `no-kernel`, so an unconfigured
 *   machine does not silently look like a pass.
 *
 *   extension_test_run({ testFile: "<repo>/e2e/notebookKernel.spec.ts" })
 */

import { test, expect } from './hostFixture';
import {
  acceptConfirm,
  cells,
  closeNotebookTab,
  deleteTempNotebook,
  expectCellCount,
  extensionEditorFor,
  fixtureNameFor,
  fixtureNotebook,
  kernelChip,
  kernelStatus,
  notebookToolbar,
  notebookToolbarButton,
  openNotebook,
  openToolbarMenu,
  toolbarMenuItem,
  writeTempNotebook,
} from './helpers';

// The host runner already pins workers to 1, so these never interleave. They are
// deliberately NOT `mode: 'serial'`: each test writes and opens its own notebook,
// so one transient failure (a dev-watch renderer reload, say) must not cascade
// into skipping the rest of the file.

const NOTEBOOK = fixtureNotebook([
  { type: 'markdown', source: '# Kernel fixture' },
  { type: 'code', source: "print('hello from the live suite')" },
]);

let notebookPath: string;

test.beforeEach(async ({ page }, testInfo) => {
  notebookPath = writeTempNotebook(fixtureNameFor(testInfo.title), NOTEBOOK);
  await openNotebook(page, notebookPath);
});

test.afterEach(async ({ page }) => {
  await closeNotebookTab(page, notebookPath);
  deleteTempNotebook(notebookPath);
});

test('renders one toolbar row with a kernel chip', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);
  const toolbar = notebookToolbar(editor);

  // One row, not two: the cell-scoped controls no longer live up here.
  await expect(toolbar).toHaveCount(1);
  await expect(toolbar).toBeVisible();
  await expect(notebookToolbarButton(editor, 'Run')).toBeVisible();
  await expect(notebookToolbarButton(editor, 'Restart')).toBeVisible();

  // Run All moved one click deep, into the Run split button's menu.
  await openToolbarMenu(editor, 'Run options');
  await expect(toolbarMenuItem(editor, 'Run all cells')).toBeVisible();
  await page.keyboard.press('Escape');

  // The badge is the user's only signal about kernel state, so it must always
  // report one of the known statuses rather than rendering blank.
  const status = await kernelStatus(editor);
  expect([
    'idle', 'busy', 'starting', 'restarting', 'autorestarting',
    'dead', 'terminating', 'unknown', 'no-kernel',
  ]).toContain(status);
  await expect(kernelChip(editor)).not.toBeEmpty();
  await expect(kernelChip(editor)).toHaveAttribute('data-status', status);
});

test('opens the runtime setup panel from the toolbar', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);
  const panel = editor.locator('.jupyter-runtime-setup');

  // With no runtime configured the panel is already showing the error state.
  // Otherwise the chip is the way in: with a kernel it opens a popover holding
  // "Runtime setup…", and without one it opens the panel directly.
  if (!(await panel.isVisible())) {
    await kernelChip(editor).click();
    const setup = toolbarMenuItem(editor, 'Runtime setup…');
    if (await setup.isVisible()) await setup.click();
  }

  await expect(panel).toBeVisible();
  await expect(panel).toContainText(/python|runtime|server/i);
});

test('runs a cell and renders its output', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);
  const status = await kernelStatus(editor);
  test.skip(
    status === 'no-kernel' || status === 'dead',
    `No Jupyter runtime available (kernel status: ${status}). Configure a runtime to cover execution.`,
  );

  await expectCellCount(editor, 2);
  await cells(editor).nth(1).click();
  await notebookToolbarButton(editor, 'Run').click();

  const output = cells(editor).nth(1).locator('.jp-OutputArea-output');
  await expect(output).toContainText('hello from the live suite', { timeout: 60000 });

  // A completed run leaves the kernel idle and stamps an execution count.
  await expect
    .poll(() => kernelStatus(editor), { timeout: 60000 })
    .toBe('idle');
  await expect(cells(editor).nth(1).locator('.jp-InputPrompt')).not.toContainText('[ ]');
});

test('clears rendered output from the toolbar', async ({ page }) => {
  const editor = extensionEditorFor(page, notebookPath);
  const status = await kernelStatus(editor);
  test.skip(
    status === 'no-kernel' || status === 'dead',
    `No Jupyter runtime available (kernel status: ${status}). Configure a runtime to cover execution.`,
  );

  await cells(editor).nth(1).click();
  await notebookToolbarButton(editor, 'Run').click();
  const output = cells(editor).nth(1).locator('.jp-OutputArea-output');
  await expect(output).toContainText('hello from the live suite', { timeout: 60000 });

  // Clear all outputs lives in the overflow menu now, and still confirms first.
  await openToolbarMenu(editor, 'More notebook actions');
  await toolbarMenuItem(editor, 'Clear all outputs').click();
  await acceptConfirm(editor, 'Clear');

  await expect(output).toHaveCount(0, { timeout: 20000 });
});

// @vitest-environment jsdom

import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as nbformat from '@jupyterlab/nbformat';

let buildNotebook: typeof import('../src/services/buildNotebook').buildNotebook;
let cellActions: typeof import('../src/services/notebookCellActions');

const notebookContent: nbformat.INotebookContent = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: 'first',
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: 'print("first")',
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'first\n' }],
    },
    {
      id: 'second',
      cell_type: 'code',
      metadata: {},
      execution_count: null,
      source: 'print("second")',
      outputs: [],
    },
  ],
};

beforeAll(async () => {
  vi.stubGlobal('DragEvent', class DragEvent extends Event {});
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
  ({ buildNotebook } = await import('../src/services/buildNotebook'));
  cellActions = await import('../src/services/notebookCellActions');
});

describe('notebook cell actions', () => {
  it('derives capabilities for the requested cell instead of the active cell', async () => {
    const built = buildNotebook(structuredClone(notebookContent), { readOnly: false });
    const { notebook } = built;
    notebook.activeCellIndex = 0;

    expect(cellActions.getCellCapabilities(notebook, 1)).toEqual({
      canMoveUp: true,
      canMoveDown: false,
      canMergeAbove: true,
      canMergeBelow: false,
      canSplit: true,
      canRun: true,
      hasOutput: false,
      inputCollapsed: false,
      outputCollapsed: false,
      outputScrolled: false,
      cellType: 'code',
    });

    await flushDeferredNotebookUpdates();
    built.dispose();
  });

  it('inserts, duplicates, clears, and merges through JupyterLab actions', async () => {
    const built = buildNotebook(structuredClone(notebookContent), { readOnly: false });
    const { notebook, model } = built;
    notebook.activeCellIndex = 0;

    cellActions.clearSelectedOutputs(notebook);
    expect(model.cells.get(0).toJSON()).toMatchObject({ outputs: [] });

    cellActions.duplicateCells(notebook);
    expect(model.cells.length).toBe(3);
    expect(model.cells.get(1).sharedModel.getSource()).toBe('print("first")');

    cellActions.insertCell(notebook, 'above', 'markdown');
    expect(model.cells.length).toBe(4);
    expect(model.cells.get(notebook.activeCellIndex).type).toBe('markdown');

    notebook.activeCellIndex = 1;
    cellActions.mergeCells(notebook, 'below');
    expect(model.cells.length).toBe(3);
    expect(model.cells.get(1).sharedModel.getSource()).toContain('print("first")');

    await flushDeferredNotebookUpdates();
    built.dispose();
  });

  it('persists per-cell input, output, and scrolling state in nbformat metadata', async () => {
    const built = buildNotebook(structuredClone(notebookContent), { readOnly: false });
    const { notebook, model } = built;
    notebook.activeCellIndex = 0;

    cellActions.toggleSelectedInputs(notebook);
    cellActions.toggleSelectedOutputs(notebook);
    cellActions.toggleSelectedOutputScrolling(notebook);

    expect(notebook.activeCell?.inputHidden).toBe(true);
    expect(notebook.activeCell && 'outputHidden' in notebook.activeCell
      ? notebook.activeCell.outputHidden
      : false).toBe(true);
    expect(notebook.activeCell && 'outputsScrolled' in notebook.activeCell
      ? notebook.activeCell.outputsScrolled
      : false).toBe(true);
    expect(model.cells.get(0).toJSON().metadata).toMatchObject({
      collapsed: true,
      scrolled: true,
      jupyter: { source_hidden: true },
    });

    cellActions.toggleSelectedInputs(notebook);
    cellActions.toggleSelectedOutputs(notebook);
    cellActions.toggleSelectedOutputScrolling(notebook);
    expect(model.cells.get(0).toJSON().metadata).toEqual({});

    await flushDeferredNotebookUpdates();
    built.dispose();
  });

  it('targets indexed insert and toggle actions without using the active selection', async () => {
    const built = buildNotebook(structuredClone(notebookContent), { readOnly: false });
    const { notebook, model } = built;
    notebook.activeCellIndex = 0;

    expect(cellActions.toggleCellInputAt(notebook, 1)).toBe(true);
    expect(cellActions.toggleCellOutputAt(notebook, 1)).toBe(true);
    expect(cellActions.toggleCellOutputScrollingAt(notebook, 1)).toBe(true);
    expect(notebook.activeCellIndex).toBe(0);
    expect(cellActions.getCellCapabilities(notebook, 1)).toMatchObject({
      inputCollapsed: true,
      outputCollapsed: true,
      outputScrolled: true,
    });

    expect(cellActions.insertCellAt(notebook, 1, 'above', 'markdown')).toBe(true);
    expect(model.cells.get(1).type).toBe('markdown');
    expect(model.cells.get(2).sharedModel.getSource()).toBe('print("second")');
    expect(cellActions.insertCellAt(notebook, 99, 'below')).toBe(false);

    await flushDeferredNotebookUpdates();
    built.dispose();
  });

  it('targets indexed structural actions and rejects unavailable directions', async () => {
    const built = buildNotebook(structuredClone(notebookContent), { readOnly: false });
    const { notebook, model } = built;
    notebook.activeCellIndex = 1;

    expect(cellActions.duplicateCellAt(notebook, 0)).toBe(true);
    expect(model.cells.get(1).sharedModel.getSource()).toBe('print("first")');
    expect(cellActions.moveCellAt(notebook, 0, 'up')).toBe(false);
    expect(cellActions.moveCellAt(notebook, 1, 'down')).toBe(true);
    expect(cellActions.changeCellTypeAt(notebook, 2, 'markdown')).toBe(true);
    expect(model.cells.get(2).type).toBe('markdown');
    expect(cellActions.deleteCellAt(notebook, 2)).toBe(true);
    expect(model.cells.length).toBe(2);

    await flushDeferredNotebookUpdates();
    built.dispose();
  });
});

async function flushDeferredNotebookUpdates(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

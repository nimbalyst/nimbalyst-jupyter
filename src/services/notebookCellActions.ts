import { CodeCell } from '@jupyterlab/cells';
import { NotebookActions, type Notebook } from '@jupyterlab/notebook';
import type * as nbformat from '@jupyterlab/nbformat';

export type CellInsertPosition = 'above' | 'below';
export type CellMoveDirection = 'up' | 'down';
export type CellMergeDirection = 'above' | 'below';

export interface CellCapabilities {
  canMoveUp: boolean;
  canMoveDown: boolean;
  canMergeAbove: boolean;
  canMergeBelow: boolean;
  canSplit: boolean;
  canRun: boolean;
  hasOutput: boolean;
  inputCollapsed: boolean;
  outputCollapsed: boolean;
  outputScrolled: boolean;
  cellType: nbformat.CellType;
}

/** Return the actions and display state for one specific cell widget. */
export function getCellCapabilities(
  notebook: Notebook,
  index: number,
): CellCapabilities | null {
  const cell = notebook.widgets[index];
  if (!cell) return null;
  const isCode = cell instanceof CodeCell;
  const editable = cell.model.getMetadata('editable') !== false;
  return {
    canMoveUp: index > 0,
    canMoveDown: index < notebook.widgets.length - 1,
    canMergeAbove: editable && index > 0 &&
      notebook.widgets[index - 1].model.getMetadata('editable') !== false,
    canMergeBelow: editable && index < notebook.widgets.length - 1 &&
      notebook.widgets[index + 1].model.getMetadata('editable') !== false,
    canSplit: editable,
    canRun: cell.model.type !== 'raw',
    hasOutput: isCode && cell.model.outputs.length > 0,
    inputCollapsed: cell.inputHidden,
    outputCollapsed: isCode && cell.outputHidden,
    outputScrolled: isCode && cell.outputsScrolled,
    cellType: cell.model.type,
  };
}

/**
 * The single run-readiness rule.
 *
 * Four entry points invoke "run this cell" -- the top toolbar's Run, the cell
 * toolbar's run, the gutter's run, and Shift/Ctrl+Enter -- so all four answer
 * this one question rather than each carrying its own version of it.
 *
 * Markdown deliberately stays runnable with no kernel: running a markdown cell
 * renders it in the browser and asks the kernel for nothing, so greying it out
 * in edit-only mode would disable an action that works. A raw cell never runs
 * at all, and a code cell always needs a kernel that is idle or busy (busy
 * queues, which is what JupyterLab does everywhere else).
 */
export function canRunCell(
  cellType: nbformat.CellType | undefined,
  kernelReady: boolean,
): boolean {
  if (cellType === undefined || cellType === 'raw') return false;
  return cellType !== 'code' || kernelReady;
}

export function selectedCells(notebook: Notebook) {
  return notebook.widgets.filter((cell) => notebook.isSelectedOrActive(cell));
}

export function insertCell(
  notebook: Notebook,
  position: CellInsertPosition,
  cellType: nbformat.CellType = 'code',
): void {
  position === 'above'
    ? NotebookActions.insertAbove(notebook)
    : NotebookActions.insertBelow(notebook);
  if (cellType !== 'code') NotebookActions.changeCellType(notebook, cellType);
}

/** Insert relative to one cell, regardless of the notebook's current selection. */
export function insertCellAt(
  notebook: Notebook,
  index: number,
  position: CellInsertPosition,
  cellType: nbformat.CellType = 'code',
): boolean {
  if (!targetCell(notebook, index)) return false;
  insertCell(notebook, position, cellType);
  return true;
}

export function duplicateCells(notebook: Notebook): void {
  NotebookActions.duplicate(notebook, 'belowSelected');
}

export function duplicateCellAt(notebook: Notebook, index: number): boolean {
  if (!targetCell(notebook, index)) return false;
  duplicateCells(notebook);
  return true;
}

export function moveCellAt(
  notebook: Notebook,
  index: number,
  direction: CellMoveDirection,
): boolean {
  const capabilities = getCellCapabilities(notebook, index);
  if (!capabilities) return false;
  if (direction === 'up' ? !capabilities.canMoveUp : !capabilities.canMoveDown) return false;
  targetCell(notebook, index);
  direction === 'up' ? NotebookActions.moveUp(notebook) : NotebookActions.moveDown(notebook);
  return true;
}

export function changeCellTypeAt(
  notebook: Notebook,
  index: number,
  cellType: nbformat.CellType,
): boolean {
  if (!targetCell(notebook, index)) return false;
  NotebookActions.changeCellType(notebook, cellType);
  return true;
}

export function deleteCellAt(notebook: Notebook, index: number): boolean {
  if (!targetCell(notebook, index)) return false;
  NotebookActions.deleteCells(notebook);
  return true;
}

export function clearSelectedOutputs(notebook: Notebook): void {
  NotebookActions.clearOutputs(notebook);
}

export function clearCellOutputAt(notebook: Notebook, index: number): boolean {
  if (!targetCell(notebook, index)) return false;
  clearSelectedOutputs(notebook);
  return true;
}

export function splitActiveCell(notebook: Notebook): void {
  NotebookActions.splitCell(notebook);
}

export function splitCellAt(notebook: Notebook, index: number): boolean {
  const capabilities = getCellCapabilities(notebook, index);
  if (!capabilities?.canSplit || !targetCell(notebook, index)) return false;
  splitActiveCell(notebook);
  return true;
}

export function mergeCells(notebook: Notebook, direction: CellMergeDirection): void {
  NotebookActions.mergeCells(notebook, direction === 'above');
}

export function mergeCellAt(
  notebook: Notebook,
  index: number,
  direction: CellMergeDirection,
): boolean {
  const capabilities = getCellCapabilities(notebook, index);
  if (!capabilities) return false;
  if (direction === 'above' ? !capabilities.canMergeAbove : !capabilities.canMergeBelow) {
    return false;
  }
  targetCell(notebook, index);
  mergeCells(notebook, direction);
  return true;
}

export function toggleSelectedInputs(notebook: Notebook): void {
  const cells = selectedCells(notebook);
  const hide = cells.some((cell) => !cell.inputHidden);
  for (const cell of cells) {
    cell.inputHidden = hide;
    cell.saveCollapseState();
  }
}

export function toggleCellInputAt(notebook: Notebook, index: number): boolean {
  const cell = notebook.widgets[index];
  if (!cell) return false;
  cell.inputHidden = !cell.inputHidden;
  cell.saveCollapseState();
  return true;
}

export function toggleSelectedOutputs(notebook: Notebook): void {
  NotebookActions.toggleOutput(notebook);
}

export function toggleCellOutputAt(notebook: Notebook, index: number): boolean {
  const cell = notebook.widgets[index];
  if (!(cell instanceof CodeCell)) return false;
  cell.outputHidden = !cell.outputHidden;
  cell.saveCollapseState();
  return true;
}

export function toggleSelectedOutputScrolling(notebook: Notebook): void {
  const cells = selectedCells(notebook).filter((cell): cell is CodeCell => cell instanceof CodeCell);
  const scroll = cells.some((cell) => !cell.outputsScrolled);
  for (const cell of cells) {
    cell.outputsScrolled = scroll;
    cell.saveScrolledState();
  }
}

export function toggleCellOutputScrollingAt(notebook: Notebook, index: number): boolean {
  const cell = notebook.widgets[index];
  if (!(cell instanceof CodeCell)) return false;
  cell.outputsScrolled = !cell.outputsScrolled;
  cell.saveScrolledState();
  return true;
}

/** Make one indexed cell the sole action target for selection-based JupyterLab APIs. */
function targetCell(notebook: Notebook, index: number): boolean {
  if (!notebook.widgets[index]) return false;
  notebook.activeCellIndex = index;
  notebook.deselectAll();
  return true;
}

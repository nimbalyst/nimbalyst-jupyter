/**
 * Live-editor surface that cell-level AI tools call through
 * `host.registerEditorAPI`. Cell read/write methods are thin wrappers
 * over the `NotebookModel`. When the editor isn't open, AI tools fall
 * back to disk via `buildNotebookProjection` — that fallback is owned
 * by the tool handler, not this API.
 *
 * runCells is reintroduced once `SessionContext` is attached (kernel
 * execution phase). It's intentionally absent here so the contract can't
 * lie about kernel-less behavior.
 */

import type { Notebook, NotebookModel } from '@jupyterlab/notebook';
import type { ICellModel } from '@jupyterlab/cells';
import type * as nbformat from '@jupyterlab/nbformat';

export type CellType = 'code' | 'markdown' | 'raw';

export interface CellSnapshot {
  id: string;
  index: number;
  cellType: CellType;
  source: string;
}

export interface JupyterEditorAPI {
  getCellById(id: string): CellSnapshot | null;
  getCellByIndex(index: number): CellSnapshot | null;
  listCells(): CellSnapshot[];
  updateCellSource(id: string, source: string): boolean;
  insertCell(opts: {
    cellType: CellType;
    source: string;
    afterId?: string | null;
  }): CellSnapshot;
}

export function createEditorAPI(
  _notebook: Notebook,
  model: NotebookModel,
): JupyterEditorAPI {
  const findIndexById = (id: string): number => {
    for (let i = 0; i < model.cells.length; i++) {
      const cell = model.cells.get(i);
      if (cell.sharedModel.getId() === id) return i;
    }
    return -1;
  };

  const snapshot = (cell: ICellModel, index: number): CellSnapshot => ({
    id: cell.sharedModel.getId(),
    index,
    cellType: cell.type as CellType,
    source: cell.sharedModel.getSource(),
  });

  return {
    getCellById(id) {
      const idx = findIndexById(id);
      if (idx < 0) return null;
      return snapshot(model.cells.get(idx), idx);
    },

    getCellByIndex(index) {
      if (index < 0 || index >= model.cells.length) return null;
      return snapshot(model.cells.get(index), index);
    },

    listCells() {
      const out: CellSnapshot[] = [];
      for (let i = 0; i < model.cells.length; i++) {
        out.push(snapshot(model.cells.get(i), i));
      }
      return out;
    },

    updateCellSource(id, source) {
      const idx = findIndexById(id);
      if (idx < 0) return false;
      model.cells.get(idx).sharedModel.setSource(source);
      return true;
    },

    insertCell({ cellType, source, afterId }) {
      const insertAt =
        afterId == null ? 0 : Math.max(0, findIndexById(afterId) + 1);
      const cellShared: nbformat.ICell =
        cellType === 'markdown'
          ? { cell_type: 'markdown', metadata: {}, source }
          : cellType === 'raw'
            ? { cell_type: 'raw', metadata: {}, source }
            : {
                cell_type: 'code',
                metadata: {},
                source,
                outputs: [],
                execution_count: null,
              };
      model.sharedModel.insertCell(
        insertAt,
        cellShared as Parameters<typeof model.sharedModel.insertCell>[1],
      );
      return snapshot(model.cells.get(insertAt), insertAt);
    },
  };
}

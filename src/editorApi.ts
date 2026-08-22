/**
 * Live-editor surface that cell-level AI tools call through
 * `host.registerEditorAPI`. Cell read/write methods are thin wrappers
 * over the `NotebookModel`. When the editor isn't open, AI tools fall
 * back to disk via `buildNotebookProjection` — that fallback is owned
 * by the tool handler, not this API.
 *
 * Execution methods accept an optional `timeoutMs`. On timeout the run
 * keeps going in the kernel; the result reports `timedOut: true` and
 * `getExecutionStatus()` lets callers poll the in-flight run. Pair with
 * `interrupt()` to actually stop a runaway cell.
 */

import type { Notebook, NotebookModel } from '@jupyterlab/notebook';
import { NotebookActions } from '@jupyterlab/notebook';
import type { ICellModel, ICodeCellModel } from '@jupyterlab/cells';
import type * as nbformat from '@jupyterlab/nbformat';
import type {
  ExecuteCodeResult,
  KernelStatus,
  SessionContextManager,
} from './services/sessionContext';
import type { StalenessTracker } from './services/stalenessTracker';

export type CellType = 'code' | 'markdown' | 'raw';

export interface CellSnapshot {
  id: string;
  index: number;
  cellType: CellType;
  source: string;
  /** Execution count for code cells; null when never run or cleared. */
  executionCount?: nbformat.ExecutionCount | null;
  /** Source changed since last run in this session. null = unknown (ran in a prior session or never). */
  stale?: boolean | null;
  /** Last run predates the latest kernel restart. null = unknown. */
  executedBeforeRestart?: boolean | null;
}

export interface CellOutputSnapshot {
  id: string;
  index: number;
  executionCount: nbformat.ExecutionCount | null;
  outputs: nbformat.IOutput[];
}

export interface RunCellResult extends CellOutputSnapshot {
  ran: boolean;
  /** True when timeoutMs elapsed while the cell was still executing. */
  timedOut?: boolean;
  kernelStatus: KernelStatus;
}

export interface RunOptions {
  /** Stop waiting after this many ms; the kernel keeps running. */
  timeoutMs?: number;
}

export interface RunAllResult {
  ran: boolean;
  timedOut?: boolean;
  kernelStatus: KernelStatus;
  cells: CellOutputSnapshot[];
}

export interface ExecutionStatusEntry {
  kind: 'cell' | 'run-all';
  cellId: string | null;
  index: number | null;
  elapsedMs: number;
  done: boolean;
  /** Only meaningful once done. */
  ran: boolean | null;
}

export interface ExecutionStatusReport {
  kernelStatus: KernelStatus;
  executions: ExecutionStatusEntry[];
}

export interface InsertCellOptions {
  cellType: CellType;
  source: string;
  /** Insert after this cell. Takes precedence over beforeId/position. */
  afterId?: string | null;
  /** Insert before this cell. */
  beforeId?: string | null;
  /** Fallback placement when no anchor cell is given. Default 'end'. */
  position?: 'start' | 'end';
}

export interface JupyterEditorAPI {
  /** Mirrors `host.readOnly`. Every mutating method below is a no-op when true. */
  isReadOnly(): boolean;
  getCellById(id: string): CellSnapshot | null;
  getCellByIndex(index: number): CellSnapshot | null;
  listCells(): CellSnapshot[];
  getCellOutputById(id: string): CellOutputSnapshot | null;
  getCellOutputByIndex(index: number): CellOutputSnapshot | null;
  getKernelStatus(): KernelStatus;
  runCellById(id: string, opts?: RunOptions): Promise<RunCellResult | null>;
  runCellByIndex(index: number, opts?: RunOptions): Promise<RunCellResult | null>;
  runAll(opts?: RunOptions): Promise<RunAllResult>;
  executeCode(
    code: string,
    opts?: { timeoutMs?: number },
  ): Promise<ExecuteCodeResult & { kernelStatus: KernelStatus }>;
  interrupt(): Promise<boolean>;
  restartKernel(opts?: { runAll?: boolean }): Promise<{
    restarted: boolean;
    ran?: boolean;
    kernelStatus: KernelStatus;
  }>;
  getExecutionStatus(): ExecutionStatusReport;
  updateCellSource(id: string, source: string): boolean;
  insertCell(opts: InsertCellOptions): CellSnapshot | null;
  deleteCell(id: string): boolean;
  moveCell(id: string, toIndex: number): CellSnapshot | null;
  setCellType(id: string, cellType: CellType): CellSnapshot | null;
  /** Clear outputs for one cell, or every code cell when id is omitted. Returns cells cleared. */
  clearOutputs(id?: string): number;
}

interface InFlightExecution {
  kind: 'cell' | 'run-all';
  cellId: string | null;
  index: number | null;
  startedAtMs: number;
  done: boolean;
  ran: boolean | null;
}

const MAX_TRACKED_EXECUTIONS = 20;

export function createEditorAPI(
  notebook: Notebook,
  model: NotebookModel,
  getSessionContext?: () => SessionContextManager | null,
  stalenessTracker?: StalenessTracker | null,
  getReadOnly?: () => boolean,
): JupyterEditorAPI {
  let inFlight: InFlightExecution[] = [];

  // `NotebookModel.readOnly` only configures the editor widgets; writes through
  // `sharedModel` and kernel execution ignore it. Guard here so the AI surface
  // cannot mutate a notebook the host opened read-only. Backstop for the checks
  // in aiTools.ts, which report a reason instead of silently no-opping.
  const readOnly = (): boolean => getReadOnly?.() === true;

  const findIndexById = (id: string): number => {
    for (let i = 0; i < model.cells.length; i++) {
      const cell = model.cells.get(i);
      if (cell.sharedModel.getId() === id) return i;
    }
    return -1;
  };

  const snapshot = (cell: ICellModel, index: number): CellSnapshot => {
    const id = cell.sharedModel.getId();
    const source = cell.sharedModel.getSource();
    const base: CellSnapshot = {
      id,
      index,
      cellType: cell.type as CellType,
      source,
    };
    if (cell.type === 'code') {
      base.executionCount = (cell as ICodeCellModel).executionCount;
      const freshness = stalenessTracker?.getFreshness(id, source);
      base.stale = freshness?.stale ?? null;
      base.executedBeforeRestart = freshness?.executedBeforeRestart ?? null;
    }
    return base;
  };

  const outputSnapshot = (cell: ICellModel, index: number): CellOutputSnapshot => {
    const base = {
      id: cell.sharedModel.getId(),
      index,
      executionCount: null,
      outputs: [] as nbformat.IOutput[],
    };
    if (cell.type !== 'code') return base;
    const codeCell = cell as ICodeCellModel;
    const outputs: nbformat.IOutput[] = [];
    for (let i = 0; i < codeCell.outputs.length; i++) {
      outputs.push(codeCell.outputs.get(i).toJSON());
    }
    return {
      ...base,
      executionCount: codeCell.executionCount,
      outputs,
    };
  };

  const getSession = (): SessionContextManager | null => getSessionContext?.() ?? null;

  const allOutputSnapshots = (): CellOutputSnapshot[] => {
    const out: CellOutputSnapshot[] = [];
    for (let i = 0; i < model.cells.length; i++) {
      out.push(outputSnapshot(model.cells.get(i), i));
    }
    return out;
  };

  const track = (entry: InFlightExecution): void => {
    inFlight = inFlight.filter((e) => !e.done).slice(-MAX_TRACKED_EXECUTIONS + 1);
    inFlight.push(entry);
  };

  /** Await `run`, or bail early after timeoutMs while the run continues. */
  const awaitWithTimeout = async (
    run: Promise<boolean>,
    entry: InFlightExecution,
    timeoutMs: number | undefined,
  ): Promise<{ ran: boolean; timedOut: boolean }> => {
    const settled = run.then(
      (ran) => {
        entry.done = true;
        entry.ran = ran;
        return ran;
      },
      () => {
        entry.done = true;
        entry.ran = false;
        return false;
      },
    );
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { ran: await settled, timedOut: false };
    }
    const winner = await Promise.race([
      settled.then((ran) => ({ timedOut: false, ran })),
      new Promise<{ timedOut: true; ran: false }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true, ran: false }), timeoutMs),
      ),
    ]);
    return winner;
  };

  const runCellAtIndexUnguarded = async (
    index: number,
    opts?: RunOptions,
  ): Promise<RunCellResult | null> => {
    if (index < 0 || index >= model.cells.length) return null;
    const sc = getSession();
    if (!sc) {
      return {
        ...outputSnapshot(model.cells.get(index), index),
        ran: false,
        kernelStatus: 'no-kernel',
      };
    }
    notebook.activeCellIndex = index;
    const entry: InFlightExecution = {
      kind: 'cell',
      cellId: model.cells.get(index).sharedModel.getId(),
      index,
      startedAtMs: Date.now(),
      done: false,
      ran: null,
    };
    track(entry);
    const { ran, timedOut } = await awaitWithTimeout(
      sc.runActive(notebook),
      entry,
      opts?.timeoutMs,
    );
    return {
      ...outputSnapshot(model.cells.get(index), index),
      ran,
      timedOut: timedOut || undefined,
      kernelStatus: sc.status,
    };
  };

  /** Executing writes outputs and execution counts back into the model. */
  const runCellAtIndex = async (
    index: number,
    opts?: RunOptions,
  ): Promise<RunCellResult | null> => {
    if (readOnly()) return null;
    return runCellAtIndexUnguarded(index, opts);
  };

  const clearCodeCell = (cell: ICellModel): boolean => {
    if (cell.type !== 'code') return false;
    const codeCell = cell as ICodeCellModel;
    codeCell.outputs.clear();
    codeCell.executionCount = null;
    return true;
  };

  return {
    isReadOnly: readOnly,

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

    getCellOutputById(id) {
      const idx = findIndexById(id);
      if (idx < 0) return null;
      return outputSnapshot(model.cells.get(idx), idx);
    },

    getCellOutputByIndex(index) {
      if (index < 0 || index >= model.cells.length) return null;
      return outputSnapshot(model.cells.get(index), index);
    },

    getKernelStatus() {
      return getSession()?.status ?? 'no-kernel';
    },

    runCellById(id, opts) {
      return runCellAtIndex(findIndexById(id), opts);
    },

    runCellByIndex(index, opts) {
      return runCellAtIndex(index, opts);
    },

    async runAll(opts) {
      if (readOnly()) {
        return {
          ran: false,
          kernelStatus: getSession()?.status ?? 'no-kernel',
          cells: allOutputSnapshots(),
        };
      }
      const sc = getSession();
      if (!sc) {
        return { ran: false, kernelStatus: 'no-kernel', cells: allOutputSnapshots() };
      }
      const entry: InFlightExecution = {
        kind: 'run-all',
        cellId: null,
        index: null,
        startedAtMs: Date.now(),
        done: false,
        ran: null,
      };
      track(entry);
      const { ran, timedOut } = await awaitWithTimeout(
        sc.runAll(notebook),
        entry,
        opts?.timeoutMs,
      );
      return {
        ran,
        timedOut: timedOut || undefined,
        kernelStatus: sc.status,
        cells: allOutputSnapshots(),
      };
    },

    async executeCode(code, opts) {
      const sc = getSession();
      if (!sc) {
        return { status: 'no-kernel', outputs: [], kernelStatus: 'no-kernel' };
      }
      const result = await sc.executeCode(code, { timeoutMs: opts?.timeoutMs });
      return { ...result, kernelStatus: sc.status };
    },

    async interrupt() {
      const sc = getSession();
      if (!sc) return false;
      await sc.interrupt();
      return true;
    },

    async restartKernel(opts) {
      const sc = getSession();
      if (!sc) return { restarted: false, kernelStatus: 'no-kernel' };
      if (readOnly()) return { restarted: false, kernelStatus: sc.status };
      const restarted = await sc.restart();
      if (!restarted || !opts?.runAll) {
        return { restarted, kernelStatus: sc.status };
      }
      const ran = await sc.runAll(notebook);
      return { restarted, ran, kernelStatus: sc.status };
    },

    getExecutionStatus() {
      const now = Date.now();
      return {
        kernelStatus: getSession()?.status ?? 'no-kernel',
        executions: inFlight.map((entry) => ({
          kind: entry.kind,
          cellId: entry.cellId,
          index: entry.cellId ? findIndexById(entry.cellId) : entry.index,
          elapsedMs: now - entry.startedAtMs,
          done: entry.done,
          ran: entry.ran,
        })),
      };
    },

    updateCellSource(id, source) {
      if (readOnly()) return false;
      const idx = findIndexById(id);
      if (idx < 0) return false;
      model.cells.get(idx).sharedModel.setSource(source);
      return true;
    },

    insertCell({ cellType, source, afterId, beforeId, position }) {
      if (readOnly()) return null;
      let insertAt: number;
      if (afterId != null && afterId.length > 0) {
        const idx = findIndexById(afterId);
        if (idx < 0) return null;
        insertAt = idx + 1;
      } else if (beforeId != null && beforeId.length > 0) {
        const idx = findIndexById(beforeId);
        if (idx < 0) return null;
        insertAt = idx;
      } else {
        insertAt = position === 'start' ? 0 : model.cells.length;
      }
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

    deleteCell(id) {
      if (readOnly()) return false;
      const idx = findIndexById(id);
      if (idx < 0) return false;
      model.sharedModel.deleteCell(idx);
      return true;
    },

    moveCell(id, toIndex) {
      if (readOnly()) return null;
      const fromIndex = findIndexById(id);
      if (fromIndex < 0) return null;
      const clamped = Math.max(0, Math.min(toIndex, model.cells.length - 1));
      if (clamped !== fromIndex) {
        model.sharedModel.moveCell(fromIndex, clamped);
      }
      return snapshot(model.cells.get(clamped), clamped);
    },

    setCellType(id, cellType) {
      if (readOnly()) return null;
      const idx = findIndexById(id);
      if (idx < 0) return null;
      if (model.cells.get(idx).type === cellType) {
        return snapshot(model.cells.get(idx), idx);
      }
      // changeCellType operates on the notebook selection; it replaces
      // the cell widget/model, so the returned snapshot may carry a new id.
      notebook.activeCellIndex = idx;
      notebook.deselectAll();
      NotebookActions.changeCellType(notebook, cellType);
      return snapshot(model.cells.get(idx), idx);
    },

    clearOutputs(id) {
      if (readOnly()) return 0;
      if (id != null) {
        const idx = findIndexById(id);
        if (idx < 0) return 0;
        return clearCodeCell(model.cells.get(idx)) ? 1 : 0;
      }
      let cleared = 0;
      for (let i = 0; i < model.cells.length; i++) {
        if (clearCodeCell(model.cells.get(i))) cleared++;
      }
      return cleared;
    },
  };
}

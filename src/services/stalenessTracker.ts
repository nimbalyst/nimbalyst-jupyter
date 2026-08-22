/**
 * Tracks per-cell execution freshness so `jupyter.list_cells` can tell
 * agents (and eventually the UI) which cells are stale.
 *
 * A cell is:
 *   - `stale: true` when its source changed after its last execution in
 *     this editor session,
 *   - `executedBeforeRestart: true` when it last ran before the most
 *     recent kernel restart (its side effects are gone from the
 *     namespace),
 *   - both `null` when the cell carries an execution count from disk but
 *     has not run in this editor session (freshness unknowable).
 *
 * Execution is observed via the static `NotebookActions.executed`
 * signal, which fires for every cell run through NotebookActions —
 * toolbar, keyboard shortcuts, and AI tools all funnel through it.
 * Kernel restarts are reported by the editor via `onKernelStatus`.
 */

import { Notebook, NotebookActions } from '@jupyterlab/notebook';
import type { Cell } from '@jupyterlab/cells';
import type { KernelStatus } from './sessionContext';

export interface CellFreshness {
  /** Source changed since the cell last ran. `null` = never ran here. */
  stale: boolean | null;
  /** Last run predates the latest kernel restart. `null` = never ran here. */
  executedBeforeRestart: boolean | null;
}

interface ExecutionRecord {
  sourceAtRun: string;
  ranAtMs: number;
  success: boolean;
  beforeRestart: boolean;
}

const UNKNOWN: CellFreshness = { stale: null, executedBeforeRestart: null };

export class StalenessTracker {
  private readonly records = new Map<string, ExecutionRecord>();
  private disposed = false;

  constructor(private readonly notebook: Notebook) {
    NotebookActions.executed.connect(this.onExecuted, this);
  }

  onKernelStatus(status: KernelStatus): void {
    if (status === 'restarting' || status === 'autorestarting') {
      for (const record of this.records.values()) {
        record.beforeRestart = true;
      }
    }
  }

  getFreshness(cellId: string, currentSource: string): CellFreshness {
    const record = this.records.get(cellId);
    if (!record) return UNKNOWN;
    return {
      stale: record.sourceAtRun !== currentSource,
      executedBeforeRestart: record.beforeRestart,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    NotebookActions.executed.disconnect(this.onExecuted, this);
    this.records.clear();
  }

  private onExecuted(
    _sender: unknown,
    args: { notebook: Notebook; cell: Cell; success: boolean },
  ): void {
    if (args.notebook !== this.notebook) return;
    if (args.cell.model.type !== 'code') return;
    this.records.set(args.cell.model.sharedModel.getId(), {
      sourceAtRun: args.cell.model.sharedModel.getSource(),
      ranAtMs: Date.now(),
      success: args.success,
      beforeRestart: false,
    });
  }
}

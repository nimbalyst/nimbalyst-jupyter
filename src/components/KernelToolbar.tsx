/**
 * Minimal P0 kernel toolbar. Renders next to the notebook with the
 * standard Jupyter actions: run, run-all, interrupt, restart,
 * restart+run-all, clear outputs, plus a live kernel-status indicator.
 *
 * Visual polish (icons, tooltips that match JupyterLab, picker for
 * non-Python kernels) lives in Phase 3 (KernelPicker.tsx).
 */

import { useEffect, useState } from 'react';
import type { Notebook } from '@jupyterlab/notebook';
import {
  type KernelStatus,
  type SessionContextManager,
} from '../services/sessionContext';
import './KernelToolbar.css';

export interface KernelToolbarProps {
  sessionContext: SessionContextManager | null;
  notebook: Notebook | null;
  disabled: boolean;
}

export function KernelToolbar({ sessionContext, notebook, disabled }: KernelToolbarProps) {
  const [status, setStatus] = useState<KernelStatus>(
    sessionContext?.status ?? 'no-kernel',
  );

  useEffect(() => {
    if (!sessionContext) {
      setStatus('no-kernel');
      return;
    }
    setStatus(sessionContext.status);
    const handler = (_sender: unknown, next: KernelStatus) => setStatus(next);
    sessionContext.statusChanged.connect(handler);
    return () => {
      sessionContext.statusChanged.disconnect(handler);
    };
  }, [sessionContext]);

  const isReady = !!sessionContext && !!notebook && !disabled;
  const isBusy = status === 'busy';

  const onRun = () => sessionContext && notebook && void sessionContext.runAndAdvance(notebook);
  const onRunAll = () => sessionContext && notebook && void sessionContext.runAll(notebook);
  const onInterrupt = () => sessionContext && void sessionContext.interrupt();
  const onRestart = () => sessionContext && void sessionContext.restart();
  const onRestartRunAll = () =>
    sessionContext && notebook && void sessionContext.restartAndRunAll(notebook);
  const onClear = () => sessionContext && notebook && sessionContext.clearAllOutputs(notebook);

  return (
    <div className="jupyter-kernel-toolbar" data-kernel-status={status}>
      <button
        type="button"
        className="jupyter-kernel-toolbar__btn"
        onClick={onRun}
        disabled={!isReady}
        title="Run cell (Shift+Enter)"
      >
        Run
      </button>
      <button
        type="button"
        className="jupyter-kernel-toolbar__btn"
        onClick={onRunAll}
        disabled={!isReady}
        title="Run all cells"
      >
        Run All
      </button>
      <span className="jupyter-kernel-toolbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="jupyter-kernel-toolbar__btn"
        onClick={onInterrupt}
        disabled={!isReady || !isBusy}
        title="Interrupt kernel"
      >
        Interrupt
      </button>
      <button
        type="button"
        className="jupyter-kernel-toolbar__btn"
        onClick={onRestart}
        disabled={!isReady}
        title="Restart kernel"
      >
        Restart
      </button>
      <button
        type="button"
        className="jupyter-kernel-toolbar__btn"
        onClick={onRestartRunAll}
        disabled={!isReady}
        title="Restart kernel and run all cells"
      >
        Restart + Run All
      </button>
      <span className="jupyter-kernel-toolbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="jupyter-kernel-toolbar__btn"
        onClick={onClear}
        disabled={!isReady}
        title="Clear all outputs"
      >
        Clear Outputs
      </button>
      <span className="jupyter-kernel-toolbar__spacer" />
      <KernelStatusBadge status={status} />
    </div>
  );
}

function KernelStatusBadge({ status }: { status: KernelStatus }) {
  const label = labelForStatus(status);
  return (
    <span className="jupyter-kernel-toolbar__status" data-status={status}>
      <span className="jupyter-kernel-toolbar__status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

function labelForStatus(status: KernelStatus): string {
  switch (status) {
    case 'idle':
      return 'Idle';
    case 'busy':
      return 'Busy';
    case 'starting':
      return 'Starting';
    case 'restarting':
      return 'Restarting';
    case 'autorestarting':
      return 'Auto-restarting';
    case 'dead':
      return 'Dead';
    case 'terminating':
      return 'Terminating';
    case 'unknown':
      return 'Unknown';
    case 'no-kernel':
      return 'No kernel';
    default:
      return String(status);
  }
}

/**
 * `SessionContextManager` wraps `@jupyterlab/apputils.SessionContext`
 * and exposes the P0 cell-execution actions a notebook UI needs:
 *
 *   - runActive / runAll / runAbove / runBelow
 *   - interrupt / restart / restartAndRunAll
 *   - clearAllOutputs
 *
 * It also surfaces the kernel status signal so the toolbar can update
 * in real time.
 *
 * Construction is async because the SessionContext has to negotiate a
 * kernel session with the server. Callers should:
 *   const sc = new SessionContextManager(opts);
 *   await sc.initialize();
 *
 * Dispose with sc.dispose() — leaks the kernel session otherwise.
 */

import { SessionContext } from '@jupyterlab/apputils';
import { ServiceManager } from '@jupyterlab/services';
import type { KernelMessage } from '@jupyterlab/services';
import type { Kernel } from '@jupyterlab/services';
import { Notebook, NotebookActions } from '@jupyterlab/notebook';
import { ISignal, Signal } from '@lumino/signaling';

export type KernelStatus = Kernel.Status | 'no-kernel';

export interface SessionContextManagerOptions {
  serviceManager: ServiceManager.IManager;
  /** Notebook file path (used as session name + identity). */
  path: string;
  /** Default kernel name; "python3" if omitted. */
  kernelName?: string;
}

export class SessionContextManager {
  readonly sessionContext: SessionContext;
  private readonly _statusChanged = new Signal<this, KernelStatus>(this);
  private _disposed = false;

  constructor(opts: SessionContextManagerOptions) {
    this.sessionContext = new SessionContext({
      sessionManager: opts.serviceManager.sessions,
      specsManager: opts.serviceManager.kernelspecs,
      name: opts.path,
      path: opts.path,
      type: 'notebook',
      kernelPreference: {
        name: opts.kernelName ?? 'python3',
        canStart: true,
        autoStartDefault: true,
        shutdownOnDispose: true,
      },
    });

    // Bridge SessionContext's statusChanged signal so consumers only
    // depend on this class, not JupyterLab internals.
    this.sessionContext.statusChanged.connect(this._onStatusChanged, this);
    this.sessionContext.kernelChanged.connect(() => {
      // Status may not fire on initial kernel attach; nudge listeners.
      this._statusChanged.emit(this.status);
    });
  }

  async initialize(): Promise<void> {
    await this.sessionContext.initialize();
  }

  get status(): KernelStatus {
    return this.sessionContext.session?.kernel?.status ?? 'no-kernel';
  }

  get statusChanged(): ISignal<this, KernelStatus> {
    return this._statusChanged;
  }

  async runActive(notebook: Notebook): Promise<boolean> {
    return NotebookActions.run(notebook, this.sessionContext);
  }

  async runAndAdvance(notebook: Notebook): Promise<boolean> {
    return NotebookActions.runAndAdvance(notebook, this.sessionContext);
  }

  async runAll(notebook: Notebook): Promise<boolean> {
    return NotebookActions.runAll(notebook, this.sessionContext);
  }

  async runAbove(notebook: Notebook): Promise<boolean> {
    return NotebookActions.runAllAbove(notebook, this.sessionContext);
  }

  async runBelow(notebook: Notebook): Promise<boolean> {
    return NotebookActions.runAllBelow(notebook, this.sessionContext);
  }

  async interrupt(): Promise<void> {
    const kernel = this.sessionContext.session?.kernel;
    if (!kernel) return;
    await kernel.interrupt();
  }

  async restart(): Promise<boolean> {
    return this.sessionContext.restartKernel().then((result) => result !== null);
  }

  async restartAndRunAll(notebook: Notebook): Promise<boolean> {
    const restarted = await this.restart();
    if (!restarted) return false;
    return this.runAll(notebook);
  }

  clearAllOutputs(notebook: Notebook): void {
    NotebookActions.clearAllOutputs(notebook);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    Signal.clearData(this);
    this.sessionContext.statusChanged.disconnect(this._onStatusChanged, this);
    this.sessionContext.dispose();
  }

  private _onStatusChanged(
    _sender: unknown,
    status: KernelMessage.Status,
  ): void {
    this._statusChanged.emit(status);
  }
}

/**
 * `SessionContextManager` wraps `@jupyterlab/apputils.SessionContext`
 * and exposes the P0 cell-execution actions a notebook UI needs:
 *
 *   - runActive / runAll / runAbove / runBelow
 *   - interrupt / restart / restartAndRunAll
 *
 * Clearing outputs is deliberately not here: it edits the document and needs
 * no kernel, so the toolbar calls `NotebookActions.clearAllOutputs` directly
 * and can offer it in edit-only mode.
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
import { NotebookActions, type Notebook } from '@jupyterlab/notebook';
import type { Cell } from '@jupyterlab/cells';
import type * as nbformat from '@jupyterlab/nbformat';
import { ISignal, Signal } from '@lumino/signaling';

export type KernelStatus = Kernel.Status | 'no-kernel';

export interface ExecuteCodeOptions {
  /** Abort waiting (not the kernel) after this many ms. Default 30000. */
  timeoutMs?: number;
  /** Record in kernel history / bump execution counter. Default false. */
  storeHistory?: boolean;
}

export interface ExecuteCodeResult {
  status: 'ok' | 'error' | 'timeout' | 'no-kernel';
  /** Outputs collected so far (partial when status is 'timeout'). */
  outputs: nbformat.IOutput[];
}

const DEFAULT_EXECUTE_TIMEOUT_MS = 30_000;

export interface SessionContextManagerOptions {
  serviceManager: ServiceManager.IManager;
  /** Notebook file path (used as session name + identity). */
  path: string;
  /** Default kernel name; "python3" if omitted. */
  kernelName?: string;
  /** Optional prebuilt context for embedding/tests. Production callers omit this. */
  sessionContext?: SessionContext;
}

export interface KernelSpecOption {
  name: string;
  displayName: string;
  language: string;
}

export interface RunProgress {
  /** One-based ordinal of the code cell currently at the front of the run. */
  readonly current: number;
  /** Number of code cells targeted by this run operation. */
  readonly total: number;
}

export interface KernelChipViewModel {
  readonly status: KernelStatus;
  readonly label: string;
  readonly kernelDisplayName: string | null;
  readonly runControlsEnabled: boolean;
}

/** Build the chip state used both with a manager and in edit-only mode. */
export function deriveKernelChipViewModel(
  status: KernelStatus,
  kernelDisplayName: string | null,
  runProgress: RunProgress | null = null,
): KernelChipViewModel {
  return {
    status,
    label: runProgress
      ? `Running cell ${runProgress.current} of ${runProgress.total}`
      : labelForKernelStatus(status),
    kernelDisplayName,
    runControlsEnabled: status === 'idle' || status === 'busy',
  };
}

export class SessionContextManager {
  readonly sessionContext: SessionContext;
  private readonly _statusChanged = new Signal<this, KernelStatus>(this);
  private readonly _runProgressChanged = new Signal<this, RunProgress | null>(this);
  private _runProgress: RunProgress | null = null;
  private _runOperation = 0;
  private _kernelSpecsPromise: Promise<KernelSpecOption[]> | null = null;
  private _disposed = false;

  constructor(opts: SessionContextManagerOptions) {
    this.sessionContext = opts.sessionContext ?? new SessionContext({
      sessionManager: opts.serviceManager.sessions,
      specsManager: opts.serviceManager.kernelspecs,
      name: opts.path,
      path: opts.path,
      type: 'notebook',
      kernelPreference: {
        name: opts.kernelName ?? 'python3',
        canStart: true,
        autoStartDefault: true,
        // This wrapper's disposeAsync() awaits shutdown before the ServiceManager
        // is disposed. SessionContext's fire-and-forget shutdown races that manager.
        shutdownOnDispose: false,
      },
    });

    // Bridge SessionContext's statusChanged signal so consumers only
    // depend on this class, not JupyterLab internals.
    this.sessionContext.statusChanged.connect(this._onStatusChanged, this);
    this.sessionContext.kernelChanged.connect(this._onKernelChanged, this);
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

  get kernelName(): string | null {
    return this.sessionContext.session?.kernel?.name ?? null;
  }

  get kernelDisplayName(): string {
    return this.sessionContext.kernelDisplayName;
  }

  get runProgress(): RunProgress | null {
    return this._runProgress;
  }

  get runProgressChanged(): ISignal<this, RunProgress | null> {
    return this._runProgressChanged;
  }

  get kernelChipViewModel(): KernelChipViewModel {
    return deriveKernelChipViewModel(
      this.status,
      this.status === 'no-kernel' ? null : this.kernelDisplayName,
      this.runProgress,
    );
  }

  listKernels(): Promise<KernelSpecOption[]> {
    if (!this._kernelSpecsPromise) {
      this._kernelSpecsPromise = this._createKernelListRequest(false);
    }
    return this._kernelSpecsPromise;
  }

  /** Bypass the list cache and explicitly refresh kernel specs from the server. */
  refreshKernels(): Promise<KernelSpecOption[]> {
    this._kernelSpecsPromise = this._createKernelListRequest(true);
    return this._kernelSpecsPromise;
  }

  async changeKernel(name: string): Promise<boolean> {
    const changed = await this.sessionContext.changeKernel({ name });
    return changed !== null;
  }

  async reconnect(): Promise<void> {
    const kernel = this.sessionContext.session?.kernel;
    if (!kernel) throw new Error('No kernel is attached.');
    await kernel.reconnect();
  }

  async shutdown(): Promise<void> {
    this._cancelRunProgress();
    await this.sessionContext.shutdown();
  }

  async runActive(notebook: Notebook): Promise<boolean> {
    return NotebookActions.run(notebook, this.sessionContext);
  }

  async runCell(notebook: Notebook, index: number): Promise<boolean> {
    if (!notebook.widgets[index]) return false;
    notebook.activeCellIndex = index;
    notebook.deselectAll();
    return this.runActive(notebook);
  }

  async runAndAdvance(notebook: Notebook): Promise<boolean> {
    return NotebookActions.runAndAdvance(notebook, this.sessionContext);
  }

  async runAll(notebook: Notebook): Promise<boolean> {
    return this._runWithProgress(
      notebook,
      notebook.widgets,
      () => NotebookActions.runAll(notebook, this.sessionContext),
    );
  }

  async runAbove(notebook: Notebook): Promise<boolean> {
    return this._runWithProgress(
      notebook,
      notebook.widgets.slice(0, notebook.activeCellIndex),
      () => NotebookActions.runAllAbove(notebook, this.sessionContext),
    );
  }

  async runBelow(notebook: Notebook): Promise<boolean> {
    return this._runWithProgress(
      notebook,
      notebook.widgets.slice(notebook.activeCellIndex),
      () => NotebookActions.runAllBelow(notebook, this.sessionContext),
    );
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

  /**
   * Run code in the kernel's user namespace without touching the
   * notebook document. Used by `jupyter.execute` and the introspection
   * tools. History is off by default so scratch checks don't bump the
   * execution counter. On timeout the kernel keeps running the code;
   * callers hold partial outputs and can `interrupt()`.
   */
  async executeCode(code: string, opts: ExecuteCodeOptions = {}): Promise<ExecuteCodeResult> {
    const kernel = this.sessionContext.session?.kernel;
    if (!kernel) {
      return { status: 'no-kernel', outputs: [] };
    }
    const future = kernel.requestExecute(
      {
        code,
        store_history: opts.storeHistory ?? false,
        silent: false,
        stop_on_error: false,
        allow_stdin: false,
      },
      false,
    );

    const outputs: nbformat.IOutput[] = [];
    let sawError = false;
    future.onIOPub = (msg: KernelMessage.IIOPubMessage) => {
      const output = iopubToOutput(msg);
      if (!output) return;
      if (output.output_type === 'error') sawError = true;
      outputs.push(output);
    };

    const timeoutMs = normalizeExecuteTimeout(opts.timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const done = future.done.then(
      (reply) => (reply?.content?.status === 'error' ? 'error' : 'done') as 'done' | 'error',
      () => 'error' as const,
    );

    try {
      const winner = await Promise.race([done, timeout]);
      if (winner === 'timeout') {
        future.dispose();
        return { status: 'timeout', outputs };
      }
      return { status: winner === 'error' || sawError ? 'error' : 'ok', outputs };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    Signal.clearData(this);
    this.sessionContext.statusChanged.disconnect(this._onStatusChanged, this);
    this.sessionContext.kernelChanged.disconnect(this._onKernelChanged, this);
    this.sessionContext.dispose();
  }

  /** Shut down the owned kernel session before disposing its managers and signals. */
  async disposeAsync(): Promise<void> {
    if (this._disposed) return;
    try {
      await this.shutdown();
    } finally {
      this.dispose();
    }
  }

  private _createKernelListRequest(forceRefresh: boolean): Promise<KernelSpecOption[]> {
    const request = (async () => {
      await this.sessionContext.specsManager.ready;
      if (forceRefresh) await this.sessionContext.specsManager.refreshSpecs();
      const specs = this.sessionContext.specsManager.specs?.kernelspecs ?? {};
      return Object.entries(specs).map(([name, model]) => ({
        name,
        displayName: model?.display_name ?? name,
        language: model?.language ?? '',
      }));
    })();
    void request.catch(() => {
      if (this._kernelSpecsPromise === request) this._kernelSpecsPromise = null;
    });
    return request;
  }

  private async _runWithProgress(
    notebook: Notebook,
    cells: readonly Cell[],
    run: () => Promise<boolean>,
  ): Promise<boolean> {
    const codeCells = new Set(cells.filter((cell) => cell.model.type === 'code'));
    if (codeCells.size === 0) return run();
    const operation = ++this._runOperation;
    let completed = 0;
    const onExecuted = (
      _sender: unknown,
      args: { notebook: Notebook; cell: Cell },
    ) => {
      if (operation !== this._runOperation || args.notebook !== notebook || !codeCells.has(args.cell)) {
        return;
      }
      completed += 1;
      const current = Math.min(completed + 1, codeCells.size);
      if (current !== this._runProgress?.current) {
        this._setRunProgress({ current, total: codeCells.size });
      }
    };
    NotebookActions.executed.connect(onExecuted);
    this._setRunProgress({ current: 1, total: codeCells.size });
    try {
      return await run();
    } finally {
      NotebookActions.executed.disconnect(onExecuted);
      if (operation === this._runOperation) this._setRunProgress(null);
    }
  }

  private _setRunProgress(progress: RunProgress | null): void {
    this._runProgress = progress;
    this._runProgressChanged.emit(progress);
  }

  private _cancelRunProgress(): void {
    this._runOperation += 1;
    if (this._runProgress) this._setRunProgress(null);
  }

  private _onStatusChanged(
    _sender: unknown,
    status: KernelMessage.Status,
  ): void {
    this._statusChanged.emit(status);
  }

  private _onKernelChanged(): void {
    // Status may not fire on initial kernel attach; nudge listeners.
    this._statusChanged.emit(this.status);
  }
}

function labelForKernelStatus(status: KernelStatus): string {
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

function normalizeExecuteTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs == null || !Number.isFinite(timeoutMs)) return DEFAULT_EXECUTE_TIMEOUT_MS;
  return Math.max(500, Math.min(Math.floor(timeoutMs), 600_000));
}

/** Map an IOPub message onto the nbformat output shape cell tools already use. */
function iopubToOutput(msg: KernelMessage.IIOPubMessage): nbformat.IOutput | null {
  const msgType = msg.header.msg_type;
  const content = msg.content as Record<string, unknown>;
  switch (msgType) {
    case 'stream':
      return {
        output_type: 'stream',
        name: content.name as nbformat.StreamType,
        text: content.text as nbformat.MultilineString,
      };
    case 'execute_result':
      return {
        output_type: 'execute_result',
        execution_count: (content.execution_count as nbformat.ExecutionCount) ?? null,
        data: (content.data as nbformat.IMimeBundle) ?? {},
        metadata: (content.metadata as nbformat.OutputMetadata) ?? {},
      };
    case 'display_data':
      return {
        output_type: 'display_data',
        data: (content.data as nbformat.IMimeBundle) ?? {},
        metadata: (content.metadata as nbformat.OutputMetadata) ?? {},
      };
    case 'error':
      return {
        output_type: 'error',
        ename: String(content.ename ?? ''),
        evalue: String(content.evalue ?? ''),
        traceback: Array.isArray(content.traceback)
          ? (content.traceback as string[])
          : [],
      };
    default:
      return null;
  }
}

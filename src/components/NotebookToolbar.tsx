/**
 * The notebook's single top row.
 *
 * One 36px `role="toolbar"` holding only notebook- or kernel-scoped actions:
 *
 *   ▶ Run ▾ · ⟳ Restart ▾ · | · + Code · + Markdown · (flex) · kernel chip · ···
 *
 * Everything else the old two-row bar exposed is one click deeper, in the menu
 * that owns it. Run is the only tinted control because it is the only one
 * pressed constantly; while the kernel is busy it swaps in place to a red Stop
 * so no neighbouring control shifts.
 *
 * The kernel chip is four of yesterday's controls in one: the Runtime button,
 * the "Kernel" label, the kernel `<select>`, and the status pill. Its dot
 * carries status, its text carries identity (or run progress), and with no
 * runtime configured it stops being a menu at all and becomes the call to
 * action that opens `RuntimeSetupPanel`.
 */

import { useEffect, useId, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { NotebookActions, type Notebook } from '@jupyterlab/notebook';
import type * as nbformat from '@jupyterlab/nbformat';

import {
  deriveKernelChipViewModel,
  type KernelChipViewModel,
  type KernelSpecOption,
  type RunProgress,
  type SessionContextManager,
} from '../services/sessionContext';
import { canRunCell, insertCell } from '../services/notebookCellActions';
import { Menu, SplitButton, useMenu, type MenuItem } from './Menu';
import type { RequestConfirm } from './ConfirmDialog';
import './NotebookToolbar.css';

/** Edit-only mode has no manager to ask, so the chip model is derived directly. */
const NO_KERNEL_CHIP = deriveKernelChipViewModel('no-kernel', null);

export interface NotebookToolbarProps {
  sessionContext: SessionContextManager | null;
  notebook: Notebook | null;
  /** Mirrors `host.readOnly`; suppresses every mutating control. */
  readOnly: boolean;
  requestConfirm: RequestConfirm;
  onError?: (message: string) => void;
  /** Opens `RuntimeSetupPanel`. Reached from the chip, both as a menu row and
   *  as the chip's whole purpose when there is no runtime at all. */
  onManageRuntime?: () => void;
  /** One-line summary of where the current server came from. */
  runtimeDescription?: string;
}

/** Props for the chip, which is a menu trigger only when there is a kernel to pick. */
interface ChipTriggerProps {
  ref: RefObject<HTMLButtonElement>;
  onClick: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  'aria-haspopup'?: 'menu';
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

export function NotebookToolbar({
  sessionContext,
  notebook,
  readOnly,
  requestConfirm,
  onError,
  onManageRuntime,
  runtimeDescription,
}: NotebookToolbarProps) {
  const idPrefix = useId();
  const [chip, setChip] = useState<KernelChipViewModel>(
    () => sessionContext?.kernelChipViewModel ?? NO_KERNEL_CHIP,
  );
  const [progress, setProgress] = useState<RunProgress | null>(
    () => sessionContext?.runProgress ?? null,
  );
  const [kernels, setKernels] = useState<KernelSpecOption[]>([]);
  const [kernelInfo, setKernelInfo] = useState<string | null>(null);
  // Run acts on the active cell, so its readiness depends on that cell's type
  // the same way the cell's own run button does.
  const [activeCellType, setActiveCellType] = useState<nbformat.CellType | undefined>(
    () => notebook?.activeCell?.model.type,
  );

  const kernelMenu = useMenu<HTMLButtonElement>({ id: `${idPrefix}-kernel` });
  const overflowMenu = useMenu<HTMLButtonElement>({ id: `${idPrefix}-overflow` });

  // Status and run progress are separate signals on the manager but one piece of
  // state here, so both are read back through `kernelChipViewModel` on either.
  useEffect(() => {
    setKernelInfo(null);
    if (!sessionContext) {
      setChip(NO_KERNEL_CHIP);
      setProgress(null);
      setKernels([]);
      return;
    }
    const sync = () => {
      setChip(sessionContext.kernelChipViewModel);
      setProgress(sessionContext.runProgress);
    };
    sync();
    sessionContext.statusChanged.connect(sync);
    sessionContext.runProgressChanged.connect(sync);
    // A manager whose server is slow can answer long after the kernel has been
    // re-initialised onto another one; that list is about a server this toolbar
    // no longer talks to.
    let current = true;
    void sessionContext.listKernels().then((specs) => {
      if (current) setKernels(specs);
    }).catch((error) => {
      if (current) onError?.(`Could not list kernels: ${messageOf(error)}`);
    });
    return () => {
      current = false;
      sessionContext.statusChanged.disconnect(sync);
      sessionContext.runProgressChanged.disconnect(sync);
    };
  }, [sessionContext, onError]);

  useEffect(() => {
    if (!notebook) {
      setActiveCellType(undefined);
      return undefined;
    }
    // `modelContentChanged` as well as `activeCellChanged`: retyping the cell
    // you are already on changes the answer without moving the selection.
    const sync = () => setActiveCellType(notebook.activeCell?.model.type);
    sync();
    notebook.activeCellChanged.connect(sync);
    notebook.modelContentChanged.connect(sync);
    return () => {
      notebook.activeCellChanged.disconnect(sync);
      notebook.modelContentChanged.disconnect(sync);
    };
  }, [notebook]);

  const hasNotebook = !!notebook;
  const canEdit = hasNotebook && !readOnly;
  // `runControlsEnabled` is kernel readiness alone; the notebook and the
  // read-only flag are the other two halves of "can this actually run".
  const kernelReady = !!sessionContext && chip.runControlsEnabled;
  const canRun = kernelReady && canEdit;
  // Running the active cell is the cell's question, not the kernel's: markdown
  // renders with no kernel at all. `canRunCell` is the rule the cell toolbar
  // and the keyboard shortcuts use, so all three agree.
  const canRunActive = canEdit && canRunCell(activeCellType, kernelReady);
  const canUseKernel = !!sessionContext && !readOnly;
  const isBusy = chip.status === 'busy';

  const runAction = (label: string, action: () => void | Promise<unknown>) => {
    void Promise.resolve().then(action).catch((error) => {
      onError?.(`${label} failed: ${messageOf(error)}`);
    });
  };

  const withKernel = (label: string, action: (sc: SessionContextManager, nb: Notebook) => void | Promise<unknown>) =>
    () => {
      if (!sessionContext || !notebook) return;
      runAction(label, () => action(sessionContext, notebook));
    };

  /**
   * Run the active cell. With no manager the cell can only be markdown -- see
   * `canRunActive` -- and `NotebookActions` renders it without a kernel, which
   * is the same fallback the cell's own run button takes.
   */
  const runActiveCell = (advance: boolean) => () => {
    if (!notebook || !canRunActive) return;
    runAction('Run cell', () => (sessionContext
      ? (advance ? sessionContext.runAndAdvance(notebook) : sessionContext.runActive(notebook))
      : (advance ? NotebookActions.runAndAdvance(notebook) : NotebookActions.run(notebook))));
  };

  const addCell = (cellType: nbformat.CellType) => {
    if (!notebook || readOnly) return;
    insertCell(notebook, 'below', cellType);
    notebook.mode = 'edit';
    notebook.activeCell?.editor?.focus();
  };

  const confirmThen = (message: string, confirmLabel: string, action: () => void) => {
    requestConfirm({ message, confirmLabel, onConfirm: action });
  };

  const onRestart = () => confirmThen(
    'Restart the kernel? All variables and imports will be cleared.',
    'Restart',
    withKernel('Restart kernel', (sc) => sc.restart()),
  );

  const onRestartRunAll = () => confirmThen(
    'Restart the kernel and run every cell? All current kernel state will be cleared.',
    'Restart and Run',
    withKernel('Restart and run all', (sc, nb) => sc.restartAndRunAll(nb)),
  );

  const onRestartClear = () => confirmThen(
    'Restart the kernel and clear every saved cell output?',
    'Restart and Clear',
    withKernel('Restart and clear outputs', async (sc, nb) => {
      if (await sc.restart()) NotebookActions.clearAllOutputs(nb);
    }),
  );

  const onShutdown = () => confirmThen(
    'Shut down the kernel? The notebook stays open in edit-only mode until a kernel starts again.',
    'Shut Down',
    withKernel('Shut down kernel', (sc) => sc.shutdown()),
  );

  // Clearing outputs edits the document, so it does not need a live kernel.
  const onClearAll = () => confirmThen(
    'Clear every saved cell output?',
    'Clear',
    () => {
      if (!notebook || readOnly) return;
      runAction('Clear outputs', () => NotebookActions.clearAllOutputs(notebook));
    },
  );

  const onSelectKernel = (name: string) => {
    if (!sessionContext || name === sessionContext.kernelName) return;
    runAction('Kernel switch', () => sessionContext.changeKernel(name));
  };

  const onKernelInfo = () => {
    if (!sessionContext) return;
    const kernel = sessionContext.sessionContext.session?.kernel;
    if (!kernel) {
      setKernelInfo(['No kernel is attached.', runtimeDescription].filter(Boolean).join('\n'));
      return;
    }
    runAction('Kernel info', async () => {
      const info = await kernel.info;
      setKernelInfo([
        `${sessionContext.kernelDisplayName} (${kernel.name}) — ${chip.label.toLowerCase()}`,
        `Language: ${info.language_info.name} ${info.language_info.version}`,
        `Implementation: ${info.implementation} ${info.implementation_version}`,
        `Protocol: ${info.protocol_version}`,
        runtimeDescription,
      ].filter(Boolean).join('\n'));
    });
  };

  const runItems: MenuItem[] = [
    {
      label: 'Run cell and advance',
      shortcut: '⇧⏎',
      disabled: !canRunActive,
      onSelect: runActiveCell(true),
    },
    {
      label: 'Run cell in place',
      shortcut: '⌘⏎',
      disabled: !canRunActive,
      onSelect: runActiveCell(false),
    },
    { kind: 'separator' },
    { label: 'Run all cells', disabled: !canRun, onSelect: withKernel('Run all cells', (sc, nb) => sc.runAll(nb)) },
    { label: 'Run all above', disabled: !canRun, onSelect: withKernel('Run above', (sc, nb) => sc.runAbove(nb)) },
    { label: 'Run all below', disabled: !canRun, onSelect: withKernel('Run below', (sc, nb) => sc.runBelow(nb)) },
  ];

  const restartItems: MenuItem[] = [
    { label: 'Restart kernel', disabled: !canUseKernel, onSelect: onRestart },
    { label: 'Restart and run all', disabled: !canRun, onSelect: onRestartRunAll },
    { label: 'Restart and clear outputs', disabled: !canUseKernel || !canEdit, onSelect: onRestartClear },
    { kind: 'separator' },
    { label: 'Interrupt', disabled: !canUseKernel, onSelect: withKernel('Interrupt kernel', (sc) => sc.interrupt()) },
    { label: 'Shut down kernel', danger: true, disabled: !canUseKernel, onSelect: onShutdown },
  ];

  const kernelItems: MenuItem[] = [
    { kind: 'header', label: 'Kernel' },
    ...(kernels.length === 0
      ? [{ label: 'No kernels available', disabled: true, onSelect: () => {} } satisfies MenuItem]
      : kernels.map((kernel): MenuItem => {
        const active = kernel.name === sessionContext?.kernelName;
        return {
          id: kernel.name,
          label: kernel.displayName,
          checked: active,
          disabled: !canUseKernel,
          shortcut: active ? chip.label.toLowerCase() : undefined,
          onSelect: () => onSelectKernel(kernel.name),
        };
      })),
    { kind: 'separator' },
    { label: 'Runtime setup…', onSelect: () => onManageRuntime?.() },
    { label: 'Reconnect', disabled: !canUseKernel, onSelect: withKernel('Reconnect', (sc) => sc.reconnect()) },
    { label: 'Kernel info', disabled: !sessionContext, onSelect: onKernelInfo },
  ];

  const overflowItems: MenuItem[] = [
    { label: 'Clear all outputs', disabled: !canEdit, onSelect: onClearAll },
    { label: 'Collapse all outputs', disabled: !canEdit, onSelect: () => notebook && NotebookActions.hideAllOutputs(notebook) },
    { label: 'Expand all outputs', disabled: !canEdit, onSelect: () => notebook && NotebookActions.showAllOutputs(notebook) },
    { kind: 'separator' },
    { label: 'Undo cell operation', shortcut: 'Z', disabled: !canEdit, onSelect: () => notebook && NotebookActions.undo(notebook) },
    { label: 'Redo cell operation', shortcut: '⇧Z', disabled: !canEdit, onSelect: () => notebook && NotebookActions.redo(notebook) },
  ];

  // With no manager at all the chip is not a picker; it is the one thing worth
  // clicking, so it opens the runtime panel directly rather than a menu whose
  // only live row would be "Runtime setup…".
  const chipOpensMenu = !!sessionContext;
  const chipTriggerProps: ChipTriggerProps = chipOpensMenu
    ? kernelMenu.triggerProps
    : { ref: kernelMenu.triggerRef, onClick: () => onManageRuntime?.() };

  const kernelName = chip.kernelDisplayName;
  const chipText = kernelName === null
    ? 'No kernel — set up runtime'
    : chip.status === 'idle' && !progress
      ? kernelName
      : `${kernelName} · ${chip.label.toLowerCase()}`;
  const chipTone = kernelName === null || ERROR_STATUSES.has(chip.status) ? 'error' : 'default';

  return (
    <>
      <div className="jupyter-toolbar" role="toolbar" aria-label="Notebook actions" data-kernel-status={chip.status}>
        {isBusy ? (
          <SplitButton
            label="Stop"
            icon={<StopIcon />}
            tone="danger"
            title="Interrupt the running kernel"
            menuLabel="Run options"
            menuId={`${idPrefix}-run`}
            // A bare Stop: every row behind the caret would only queue more
            // work on a kernel that is already running. The container keeps
            // its width (`jupyter-toolbar__run`), so Restart does not shift.
            menuHidden
            disabled={!canUseKernel}
            items={runItems}
            onClick={withKernel('Interrupt kernel', (sc) => sc.interrupt())}
            className="jupyter-toolbar__run"
            data-testid="jupyter-toolbar-run"
          />
        ) : (
          <SplitButton
            label="Run"
            icon={<PlayIcon />}
            tone="primary"
            title="Run the active cell and advance (Shift+Enter)"
            menuLabel="Run options"
            menuId={`${idPrefix}-run`}
            // The halves answer to different questions: the primary runs the
            // active cell, the caret also holds the kernel-wide run-alls.
            disabled={!canRunActive && !canRun}
            mainDisabled={!canRunActive}
            items={runItems}
            onClick={runActiveCell(true)}
            className="jupyter-toolbar__run"
            data-testid="jupyter-toolbar-run"
          />
        )}
        <SplitButton
          label="Restart"
          icon={<RestartIcon />}
          title="Restart the kernel"
          menuLabel="Kernel options"
          menuId={`${idPrefix}-restart`}
          disabled={!canUseKernel}
          items={restartItems}
          onClick={onRestart}
          data-testid="jupyter-toolbar-restart"
        />
        <span className="jupyter-toolbar__sep" aria-hidden="true" />
        <button
          type="button"
          className="jupyter-toolbar__btn"
          onClick={() => addCell('code')}
          disabled={!canEdit}
          title="Insert a code cell below the active cell"
          aria-label="Insert code cell below"
        >
          <PlusIcon />
          Code
        </button>
        <button
          type="button"
          className="jupyter-toolbar__btn"
          onClick={() => addCell('markdown')}
          disabled={!canEdit}
          title="Insert a markdown cell below the active cell"
          aria-label="Insert markdown cell below"
        >
          <PlusIcon />
          Markdown
        </button>
        <span className="jupyter-toolbar__spacer" />
        <button
          type="button"
          className="jupyter-toolbar__chip"
          data-status={chip.status}
          data-tone={chipTone}
          data-testid="jupyter-toolbar-kernel-chip"
          title={runtimeDescription ?? 'Kernel and runtime'}
          aria-label={`Kernel: ${chipText}`}
          {...chipTriggerProps}
        >
          <span className="jupyter-toolbar__dot" aria-hidden="true" />
          <span className="jupyter-toolbar__chip-label">{chipText}</span>
          {chipOpensMenu ? <CaretIcon /> : null}
        </button>
        <button
          type="button"
          className="jupyter-toolbar__btn jupyter-toolbar__btn--icon"
          title="More notebook actions"
          aria-label="More notebook actions"
          data-testid="jupyter-toolbar-overflow"
          {...overflowMenu.triggerProps}
        >
          <EllipsisIcon />
        </button>
        {chipOpensMenu ? (
          <Menu {...kernelMenu.menuProps} items={kernelItems} align="end" label="Kernel" minWidth={250} />
        ) : null}
        <Menu {...overflowMenu.menuProps} items={overflowItems} align="end" label="More notebook actions" />
      </div>
      {kernelInfo ? (
        <div className="jupyter-toolbar__info" role="status">
          <pre className="jupyter-toolbar__info-text">{kernelInfo}</pre>
          <button
            type="button"
            className="jupyter-toolbar__btn"
            onClick={() => setKernelInfo(null)}
            title="Dismiss kernel info"
            aria-label="Dismiss kernel info"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </>
  );
}

const ERROR_STATUSES = new Set(['dead', 'terminating', 'unknown', 'no-kernel']);

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M4.5 3.2v9.6L13 8z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function RestartIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.85" />
      <path d="M13.4 2.2v3.1h-3.1" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

function EllipsisIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <circle cx="3.2" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.8" cy="8" r="1.3" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

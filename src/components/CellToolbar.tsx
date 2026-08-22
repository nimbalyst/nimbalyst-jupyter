/**
 * Cell-scoped chrome: the hover/focus toolbar at a cell's top-right, and the
 * gutter that carries its execution count and hover run button.
 *
 * This replaces the old global second toolbar row, whose every control acted on
 * "the selected cell" -- a target the user could not see. Everything here is
 * addressed by cell, so `getCellCapabilities` can disable exactly the actions
 * that do not apply (merge-above on the first cell, clear-output on a cell with
 * no output) instead of showing a permanently greyed button in a global bar.
 *
 * ## Mounting
 *
 * The notebook is a bare Lumino `Notebook` with no `NotebookPanel`, so there is
 * no JupyterLab cell-toolbar extension point to hang off. `CellChrome` is the
 * lifecycle owner: it keeps one plain host `<div>` inside each cell's node and
 * renders a React portal into it. Cells are re-scanned whenever the model's cell
 * list changes, so adds, removes and reorders all land in the same code path,
 * and every host is removed again on unmount. Nothing per-cell is stored in the
 * module-level factories `buildNotebook.ts` shares between editors.
 *
 * Menus are portaled to `document.body` rather than rendered in place. The
 * `Menu` surface is `position: fixed`, so any `transform` on an ancestor (which
 * a windowed `jp-WindowedPanel-inner` may acquire) would silently become its
 * containing block and misplace it.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { Cell } from '@jupyterlab/cells';
import type { ICodeCellModel } from '@jupyterlab/cells';
import { NotebookActions, type Notebook } from '@jupyterlab/notebook';
import type * as nbformat from '@jupyterlab/nbformat';

import {
  canRunCell,
  changeCellTypeAt,
  clearCellOutputAt,
  deleteCellAt,
  duplicateCellAt,
  getCellCapabilities,
  insertCellAt,
  mergeCellAt,
  moveCellAt,
  splitCellAt,
  toggleCellInputAt,
  toggleCellOutputAt,
  toggleCellOutputScrollingAt,
  type CellCapabilities,
} from '../services/notebookCellActions';
import type { SessionContextManager } from '../services/sessionContext';
import type { StalenessTracker } from '../services/stalenessTracker';
import { Menu, useMenu, type MenuItem } from './Menu';
import type { RequestConfirm } from './ConfirmDialog';
import './CellToolbar.css';

/** Marks a cell node that carries our chrome, so its `jp-InputPrompt` can hide. */
const CHROMED_CELL_CLASS = 'jupyter-cell--chromed';

/**
 * Content changes arrive per keystroke. The chrome only reflects coarse state
 * (execution count, staleness, capabilities), so it is refreshed on a trailing
 * timer rather than re-deriving every cell's freshness while the user types.
 */
const REFRESH_DELAY_MS = 200;

const CELL_TYPE_LABELS: Record<nbformat.CellType, string> = {
  code: 'Code',
  markdown: 'Markdown',
  raw: 'Raw',
};

/** How a code cell's last run relates to its current source. */
type Freshness = 'fresh' | 'stale' | 'restarted' | 'unknown' | 'never';

const FRESHNESS_TITLES: Record<Freshness, string> = {
  fresh: 'Up to date with its last run',
  stale: 'Edited since it last ran',
  restarted: 'Last ran before the kernel restarted',
  unknown: 'Ran before this editor session — freshness unknown',
  never: 'Has not run in this session',
};

export interface CellChromeProps {
  notebook: Notebook | null;
  sessionContext: SessionContextManager | null;
  /** Supplies per-cell freshness. Absent until the notebook has been built. */
  staleness: StalenessTracker | null;
  /** Mirrors `host.readOnly`. When true no cell chrome is mounted at all. */
  readOnly: boolean;
  requestConfirm: RequestConfirm;
  onError?: (message: string) => void;
}

interface CellSlot {
  id: string;
  cell: Cell;
  host: HTMLElement;
}

export function CellChrome({
  notebook,
  sessionContext,
  staleness,
  readOnly,
  requestConfirm,
  onError,
}: CellChromeProps) {
  const hostsRef = useRef(new Map<string, HTMLElement>());
  const [slots, setSlots] = useState<CellSlot[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // A cell whose menu is open stays chromed even once the pointer has moved to
  // the menu surface, which lives outside the notebook entirely.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [kernelReady, setKernelReady] = useState(false);
  const [revision, refresh] = useReducer((version: number) => version + 1, 0);

  // ---- host lifecycle -------------------------------------------------------

  useEffect(() => {
    const hosts = hostsRef.current;
    /** Hand whichever node holds this host back unmarked. */
    const dropHost = (host: HTMLElement) => {
      host.parentElement?.classList.remove(CHROMED_CELL_CLASS);
      host.remove();
    };
    const teardown = () => {
      for (const host of hosts.values()) dropHost(host);
      hosts.clear();
    };

    if (!notebook || readOnly) {
      teardown();
      setSlots([]);
      setPinnedId(null);
      return undefined;
    }

    const sync = () => {
      const seen = new Set<string>();
      const next: CellSlot[] = [];
      for (const cell of notebook.widgets) {
        if (cell.isDisposed || cell.model.isDisposed) continue;
        const id = cell.model.sharedModel.getId();
        let host = hosts.get(id);
        // A recycled or re-parented cell node needs a fresh host; comparing the
        // parent is what catches a cell that JupyterLab rebuilt underneath us.
        // The abandoned node is un-marked, or it hides its own prompt forever.
        if (!host || host.parentElement !== cell.node) {
          if (host) dropHost(host);
          host = document.createElement('div');
          host.className = 'jupyter-cell-chrome';
          cell.node.classList.add(CHROMED_CELL_CLASS);
          cell.node.appendChild(host);
          hosts.set(id, host);
        }
        seen.add(id);
        next.push({ id, cell, host });
      }
      for (const [id, host] of [...hosts]) {
        if (seen.has(id)) continue;
        dropHost(host);
        hosts.delete(id);
      }
      setSlots((current) => (sameSlots(current, next) ? current : next));
      setActiveId(notebook.activeCell?.model.sharedModel.getId() ?? null);
    };

    sync();
    const cells = notebook.model?.cells;
    cells?.changed.connect(sync);
    notebook.activeCellChanged.connect(sync);
    return () => {
      cells?.changed.disconnect(sync);
      notebook.activeCellChanged.disconnect(sync);
      teardown();
    };
  }, [notebook, readOnly]);

  // ---- state that the chrome reflects ---------------------------------------

  useEffect(() => {
    if (!notebook || readOnly) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, REFRESH_DELAY_MS);
    };
    const onExecuted = (_sender: unknown, args: { notebook: Notebook }) => {
      if (args.notebook === notebook) refresh();
    };
    notebook.modelContentChanged.connect(schedule);
    notebook.stateChanged.connect(schedule);
    NotebookActions.executed.connect(onExecuted);
    return () => {
      if (timer) clearTimeout(timer);
      notebook.modelContentChanged.disconnect(schedule);
      notebook.stateChanged.disconnect(schedule);
      NotebookActions.executed.disconnect(onExecuted);
    };
  }, [notebook, readOnly]);

  useEffect(() => {
    if (!sessionContext) {
      setKernelReady(false);
      return undefined;
    }
    const sync = () => setKernelReady(sessionContext.kernelChipViewModel.runControlsEnabled);
    sync();
    sessionContext.statusChanged.connect(sync);
    return () => {
      sessionContext.statusChanged.disconnect(sync);
    };
  }, [sessionContext]);

  // ---- hover tracking -------------------------------------------------------

  useEffect(() => {
    if (!notebook || readOnly) return undefined;
    const node = notebook.node;
    const onOver = (event: MouseEvent) => {
      const target = event.target;
      const element = target instanceof Element ? target : null;
      const cellNode = element?.closest('.jp-Cell') ?? null;
      const cell = cellNode ? notebook.widgets.find((widget) => widget.node === cellNode) : undefined;
      setHoveredId(cell ? cell.model.sharedModel.getId() : null);
    };
    const onLeave = () => setHoveredId(null);
    node.addEventListener('mouseover', onOver);
    node.addEventListener('mouseleave', onLeave);
    return () => {
      node.removeEventListener('mouseover', onOver);
      node.removeEventListener('mouseleave', onLeave);
    };
  }, [notebook, readOnly]);

  // ---- actions --------------------------------------------------------------

  const report = useCallback(
    (label: string, error: unknown) => onError?.(`${label} failed: ${messageOf(error)}`),
    [onError],
  );

  const runCell = useCallback(
    (cell: Cell) => {
      if (!notebook) return;
      const index = notebook.widgets.indexOf(cell);
      if (index < 0) return;
      if (sessionContext) {
        void sessionContext.runCell(notebook, index).catch((error) => report('Run cell', error));
        return;
      }
      // No kernel: markdown renders anyway -- see `canRunCell`.
      notebook.activeCellIndex = index;
      notebook.deselectAll();
      void NotebookActions.run(notebook).catch((error) => report('Run cell', error));
    },
    [notebook, sessionContext, report],
  );

  const onMenuOpenChange = useCallback((id: string, open: boolean) => {
    setPinnedId((current) => (open ? id : current === id ? null : current));
  }, []);

  if (!notebook || readOnly || slots.length === 0) return null;

  return (
    <>
      {slots.map((slot) => {
        // A removed cell is disposed before the list change reaches `sync`, and
        // reading capabilities off a disposed model throws, so this render can
        // legitimately see a slot that no longer has anything behind it.
        if (slot.cell.isDisposed || slot.cell.model.isDisposed) return null;
        const index = notebook.widgets.indexOf(slot.cell);
        const capabilities = index < 0 ? null : getCellCapabilities(notebook, index);
        if (!capabilities) return null;
        const visible = slot.id === hoveredId || slot.id === activeId || slot.id === pinnedId;
        const canRun = canRunCell(capabilities.cellType, kernelReady);
        return createPortal(
          <>
            {capabilities.cellType === 'code' ? (
              <CellGutter
                label={executionLabel(slot.cell, revision)}
                freshness={freshnessOf(slot.cell, staleness)}
                showRun={visible}
                canRun={canRun}
                onRun={() => runCell(slot.cell)}
              />
            ) : null}
            {visible ? (
              <CellToolbar
                notebook={notebook}
                cell={slot.cell}
                capabilities={capabilities}
                canRun={canRun}
                requestConfirm={requestConfirm}
                onRun={() => runCell(slot.cell)}
                onMenuOpenChange={(open) => onMenuOpenChange(slot.id, open)}
              />
            ) : null}
          </>,
          slot.host,
          slot.id,
        );
      })}
    </>
  );
}

// ---------------------------------------------------------------------------
// Gutter
// ---------------------------------------------------------------------------

interface CellGutterProps {
  /** Bracketed execution count, e.g. `[2]`, `[ ]`, `[*]`. */
  label: string;
  freshness: Freshness;
  showRun: boolean;
  canRun: boolean;
  onRun: () => void;
}

/**
 * Execution count plus the hover run button, in the column JupyterLab's own
 * `jp-InputPrompt` occupies (that prompt is hidden by CSS wherever this
 * mounts). The count doubles as the staleness indicator: `stalenessTracker`
 * distinguishes "edited since it ran" from "ran before this session, so we
 * cannot know", and those are deliberately two different tones here.
 */
export function CellGutter({ label, freshness, showRun, canRun, onRun }: CellGutterProps) {
  return (
    <div className="jupyter-cell-gutter">
      <span
        className="jupyter-cell-gutter__count"
        data-freshness={freshness}
        title={FRESHNESS_TITLES[freshness]}
      >
        {label}
      </span>
      {showRun ? (
        <button
          type="button"
          className="jupyter-cell-gutter__run"
          disabled={!canRun}
          title="Run this cell"
          aria-label="Run this cell"
          onMouseDown={keepEditorFocus}
          onClick={onRun}
        >
          <PlayIcon />
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export interface CellToolbarProps {
  notebook: Notebook;
  cell: Cell;
  capabilities: CellCapabilities;
  /** Kernel readiness already folded in with the cell's own `canRun`. */
  canRun: boolean;
  requestConfirm: RequestConfirm;
  onRun: () => void;
  onMenuOpenChange: (open: boolean) => void;
}

export function CellToolbar({
  notebook,
  cell,
  capabilities,
  canRun,
  requestConfirm,
  onRun,
  onMenuOpenChange,
}: CellToolbarProps) {
  const typeMenu = useMenu<HTMLButtonElement>({ onOpenChange: onMenuOpenChange });
  const overflowMenu = useMenu<HTMLButtonElement>({ onOpenChange: onMenuOpenChange });

  /**
   * Resolved per action rather than captured: a cell's index shifts whenever a
   * neighbour is inserted, moved or deleted, and the chrome outlives that.
   */
  const indexOf = useCallback(() => notebook.widgets.indexOf(cell), [notebook, cell]);

  const typeItems = useMemo<MenuItem[]>(
    () => (['code', 'markdown', 'raw'] as nbformat.CellType[]).map((cellType) => ({
      id: cellType,
      label: CELL_TYPE_LABELS[cellType],
      checked: capabilities.cellType === cellType,
      onSelect: () => changeCellTypeAt(notebook, indexOf(), cellType),
    })),
    [capabilities.cellType, notebook, indexOf],
  );

  // The collapse and scroll rows are toggles, so each is labelled by the action
  // it will perform. The old bar's bare `Input` / `Output` / `Scroll` buttons
  // never revealed that they had two states at all.
  const overflowItems = useMemo<MenuItem[]>(
    () => [
      {
        label: 'Split cell at cursor',
        shortcut: '⌃⇧−',
        disabled: !capabilities.canSplit,
        onSelect: () => splitCellAt(notebook, indexOf()),
      },
      {
        label: 'Merge with cell above',
        shortcut: '⇧M',
        disabled: !capabilities.canMergeAbove,
        onSelect: () => mergeCellAt(notebook, indexOf(), 'above'),
      },
      {
        label: 'Merge with cell below',
        disabled: !capabilities.canMergeBelow,
        onSelect: () => mergeCellAt(notebook, indexOf(), 'below'),
      },
      { kind: 'separator' },
      {
        label: 'Clear output',
        disabled: !capabilities.hasOutput,
        onSelect: () => clearCellOutputAt(notebook, indexOf()),
      },
      {
        label: capabilities.inputCollapsed ? 'Expand input' : 'Collapse input',
        onSelect: () => toggleCellInputAt(notebook, indexOf()),
      },
      {
        label: capabilities.outputCollapsed ? 'Expand output' : 'Collapse output',
        disabled: capabilities.cellType !== 'code',
        onSelect: () => toggleCellOutputAt(notebook, indexOf()),
      },
      {
        label: capabilities.outputScrolled ? 'Stop scrolling output' : 'Scroll output',
        disabled: capabilities.cellType !== 'code',
        onSelect: () => toggleCellOutputScrollingAt(notebook, indexOf()),
      },
      { kind: 'separator' },
      {
        label: 'Insert cell above',
        shortcut: 'A',
        onSelect: () => insertCellAt(notebook, indexOf(), 'above'),
      },
      {
        label: 'Insert cell below',
        shortcut: 'B',
        onSelect: () => insertCellAt(notebook, indexOf(), 'below'),
      },
    ],
    [capabilities, notebook, indexOf],
  );

  const onDelete = () => {
    requestConfirm({
      message: 'Delete this notebook cell?',
      confirmLabel: 'Delete',
      onConfirm: () => deleteCellAt(notebook, indexOf()),
    });
  };

  const typeLabel = CELL_TYPE_LABELS[capabilities.cellType];

  return (
    <div className="jupyter-cell-toolbar" role="toolbar" aria-label="Cell actions">
      <button
        type="button"
        className="jupyter-cell-toolbar__btn"
        disabled={!canRun}
        title="Run this cell"
        aria-label="Run this cell"
        onMouseDown={keepEditorFocus}
        onClick={onRun}
      >
        <PlayIcon />
      </button>
      <button
        type="button"
        className="jupyter-cell-toolbar__btn jupyter-cell-toolbar__btn--text"
        title={`Cell type: ${typeLabel}`}
        aria-label={`Cell type: ${typeLabel}`}
        onMouseDown={keepEditorFocus}
        {...typeMenu.triggerProps}
      >
        {typeLabel}
        <CaretIcon />
      </button>
      <span className="jupyter-cell-toolbar__sep" aria-hidden="true" />
      <IconButton
        label="Move cell up"
        disabled={!capabilities.canMoveUp}
        onClick={() => moveCellAt(notebook, indexOf(), 'up')}
      >
        <ArrowUpIcon />
      </IconButton>
      <IconButton
        label="Move cell down"
        disabled={!capabilities.canMoveDown}
        onClick={() => moveCellAt(notebook, indexOf(), 'down')}
      >
        <ArrowDownIcon />
      </IconButton>
      <IconButton label="Duplicate cell" onClick={() => duplicateCellAt(notebook, indexOf())}>
        <DuplicateIcon />
      </IconButton>
      <span className="jupyter-cell-toolbar__sep" aria-hidden="true" />
      <button
        type="button"
        className="jupyter-cell-toolbar__btn"
        title="More cell actions"
        aria-label="More cell actions"
        onMouseDown={keepEditorFocus}
        {...overflowMenu.triggerProps}
      >
        <EllipsisIcon />
      </button>
      <button
        type="button"
        className="jupyter-cell-toolbar__btn jupyter-cell-toolbar__btn--danger"
        title="Delete cell"
        aria-label="Delete cell"
        onMouseDown={keepEditorFocus}
        onClick={onDelete}
      >
        <TrashIcon />
      </button>
      {typeMenu.open
        ? createPortal(
          <Menu {...typeMenu.menuProps} items={typeItems} align="start" label="Cell type" minWidth={160} />,
          document.body,
        )
        : null}
      {overflowMenu.open
        ? createPortal(
          <Menu {...overflowMenu.menuProps} items={overflowItems} align="end" label="More cell actions" minWidth={240} />,
          document.body,
        )
        : null}
    </div>
  );
}

interface IconButtonProps {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}

function IconButton({ label, disabled = false, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      className="jupyter-cell-toolbar__btn"
      disabled={disabled}
      title={label}
      aria-label={label}
      onMouseDown={keepEditorFocus}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pressing a chrome button must not pull the caret out of the cell editor, so
 * the default mousedown focus transfer is suppressed. Menu triggers keep their
 * click and keyboard behaviour; the `Menu` itself moves focus once it opens.
 */
function keepEditorFocus(event: ReactMouseEvent): void {
  event.preventDefault();
}

function sameSlots(a: CellSlot[], b: CellSlot[]): boolean {
  return a.length === b.length && a.every((slot, index) => slot.id === b[index].id && slot.host === b[index].host);
}

/**
 * `[2]`, `[ ]` before a first run, `[*]` while running.
 *
 * The running case is not on the model -- JupyterLab clears `executionCount`
 * and writes `*` straight into the prompt node -- so that one state is read
 * back off the DOM. `revision` is unused but keeps the value recomputed on the
 * chrome's refresh tick rather than memoised across it.
 */
function executionLabel(cell: Cell, revision: number): string {
  void revision;
  const count = (cell.model as ICodeCellModel).executionCount;
  if (count !== null && count !== undefined) return `[${count}]`;
  const prompt = cell.node.querySelector('.jp-InputPrompt')?.textContent ?? '';
  return prompt.includes('*') ? '[*]' : '[ ]';
}

function freshnessOf(cell: Cell, staleness: StalenessTracker | null): Freshness {
  const id = cell.model.sharedModel.getId();
  const record = staleness?.getFreshness(id, cell.model.sharedModel.getSource());
  if (!record || record.stale === null) {
    const count = (cell.model as ICodeCellModel).executionCount;
    // A count with no record means the cell ran in some earlier session: its
    // freshness is unknowable, which is not the same claim as "stale".
    return count === null || count === undefined ? 'never' : 'unknown';
  }
  if (record.stale) return 'stale';
  return record.executedBeforeRestart ? 'restarted' : 'fresh';
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

// ---------------------------------------------------------------------------
// Icons -- 14x14, currentColor, no icon library.
// ---------------------------------------------------------------------------

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M4.5 3.2v9.6L13 8z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8 12.5V3.5M4.5 7 8 3.5 11.5 7" />
    </svg>
  );
}

function ArrowDownIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M8 3.5v9M4.5 9 8 12.5 11.5 9" />
    </svg>
  );
}

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="5.5" y="2.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 13.5h-7a1 1 0 0 1-1-1v-7" />
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

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8.2h4.8L11 4.5" />
    </svg>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

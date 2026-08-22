/**
 * Keyboard handling for the bare `Notebook` widget.
 *
 * Extracted from `JupyterNotebookEditor` so the editor component stays about
 * lifecycle rather than key codes; the behaviour is unchanged.
 *
 * JupyterLab's own run shortcuts and command-mode keymap come from the
 * application shell's `CommandRegistry`, which does not exist here -- the
 * notebook is mounted as a lone Lumino widget. So Shift+Enter, Ctrl/Cmd+Enter
 * and the command-mode single-key commands are captured directly on the
 * notebook's DOM node instead.
 */

import { NotebookActions, type Notebook } from '@jupyterlab/notebook';

import { canRunCell } from './notebookCellActions';
import type { SessionContextManager } from './sessionContext';

/** Structural stand-in for `useConfirm`'s `requestConfirm`, to keep services free of component imports. */
export type ConfirmRequester = (request: {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
}) => void;

export interface NotebookShortcutOptions {
  /** Read live: the manager is replaced whenever the kernel is re-initialized. */
  getSessionContext: () => SessionContextManager | null;
  /** Read live: the host can flip read-only while the editor is mounted. */
  isReadOnly: () => boolean;
  onError: (message: string) => void;
  requestConfirm: ConfirmRequester;
}

/** Keys that mutate the document, and so are swallowed in read-only mode. */
const MUTATING_KEYS = ['a', 'b', 'm', 'y', 'r', 'x', 'v', 'z', 'd'];

/** Window, in ms, in which a second `d` completes the `dd` delete shortcut. */
const DOUBLE_D_MS = 700;

export function attachKernelShortcuts(
  notebook: Notebook,
  { getSessionContext, isReadOnly, onError, requestConfirm }: NotebookShortcutOptions,
): void {
  const node = notebook.node;
  let lastDeleteKeyAt = 0;

  node.addEventListener('keydown', (ev: KeyboardEvent) => {
    const isEnter = ev.key === 'Enter';
    const sc = getSessionContext();
    if (isEnter && !isReadOnly() && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      ev.stopPropagation();
      // Same question the toolbar's Run and the cell's run button ask. When it
      // says no, the shortcut is swallowed rather than falling through: a
      // disabled button does nothing, and so does this.
      const ready = sc?.kernelChipViewModel.runControlsEnabled === true;
      if (!canRunCell(notebook.activeCell?.model.type, ready)) return;
      const advance = ev.shiftKey;
      // With no manager the cell can only be markdown, which renders without
      // one -- the same fallback the cell's own run button takes.
      const run = sc
        ? (advance ? sc.runAndAdvance(notebook) : sc.runActive(notebook))
        : (advance ? NotebookActions.runAndAdvance(notebook) : NotebookActions.run(notebook));
      void Promise.resolve(run).catch((caught) => {
        onError(`Run cell failed: ${messageOf(caught)}`);
      });
      return;
    }
    if (ev.key === 'Escape') {
      notebook.mode = 'command';
      return;
    }
    if (notebook.mode !== 'command' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const prevent = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    if (isReadOnly() && MUTATING_KEYS.includes(ev.key)) {
      prevent();
      return;
    }
    if (isEnter) {
      prevent();
      notebook.mode = 'edit';
    } else if (ev.shiftKey && ev.key === 'ArrowUp') {
      prevent();
      NotebookActions.extendSelectionAbove(notebook);
    } else if (ev.shiftKey && ev.key === 'ArrowDown') {
      prevent();
      NotebookActions.extendSelectionBelow(notebook);
    } else if (ev.key === 'j' || ev.key === 'ArrowDown') {
      prevent();
      NotebookActions.selectBelow(notebook);
    } else if (ev.key === 'k' || ev.key === 'ArrowUp') {
      prevent();
      NotebookActions.selectAbove(notebook);
    } else if (ev.key === 'a') {
      prevent();
      NotebookActions.insertAbove(notebook);
    } else if (ev.key === 'b') {
      prevent();
      NotebookActions.insertBelow(notebook);
    } else if (ev.key === 'm' || ev.key === 'y' || ev.key === 'r') {
      prevent();
      NotebookActions.changeCellType(
        notebook,
        ev.key === 'm' ? 'markdown' : ev.key === 'r' ? 'raw' : 'code',
      );
    } else if (ev.key === 'x') {
      prevent();
      NotebookActions.cut(notebook);
    } else if (ev.key === 'c') {
      prevent();
      NotebookActions.copy(notebook);
    } else if (ev.key === 'v') {
      prevent();
      NotebookActions.paste(notebook, 'below');
    } else if (ev.key === 'z') {
      prevent();
      ev.shiftKey ? NotebookActions.redo(notebook) : NotebookActions.undo(notebook);
    } else if (ev.key === 'd') {
      const now = Date.now();
      if (now - lastDeleteKeyAt < DOUBLE_D_MS) {
        prevent();
        lastDeleteKeyAt = 0;
        requestConfirm({
          message: 'Delete the selected notebook cell(s)?',
          confirmLabel: 'Delete',
          onConfirm: () => NotebookActions.deleteCells(notebook),
        });
      } else {
        lastDeleteKeyAt = now;
      }
    }
  });
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

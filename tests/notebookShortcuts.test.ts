// @vitest-environment jsdom

/**
 * Keyboard run shortcuts.
 *
 * Shift+Enter and Ctrl/Cmd+Enter are the third way to run a cell, alongside the
 * top toolbar's Run and the cell's own run button, and all three invoke the
 * same action -- so all three ask `canRunCell` the same question. What is
 * covered here is that agreement: a shortcut must not execute against a kernel
 * that the buttons next to it report as unavailable, and it must still render a
 * markdown cell in edit-only mode, which is exactly what those buttons allow.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Signal } from '@lumino/signaling';
import type * as nbformat from '@jupyterlab/nbformat';
import type { Notebook, NotebookActions as NotebookActionsType } from '@jupyterlab/notebook';

import type { KernelStatus, SessionContextManager } from '../src/services/sessionContext';

let attachKernelShortcuts: typeof import('../src/services/notebookShortcuts').attachKernelShortcuts;
let deriveKernelChipViewModel: typeof import('../src/services/sessionContext').deriveKernelChipViewModel;
let buildNotebook: typeof import('../src/services/buildNotebook').buildNotebook;
let NotebookActions: typeof NotebookActionsType;

const notebookContent: nbformat.INotebookContent = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    { id: 'code', cell_type: 'code', metadata: {}, execution_count: null, source: 'x = 1', outputs: [] },
    { id: 'md', cell_type: 'markdown', metadata: {}, source: '# heading' },
  ],
};

const pendingIdleCallbacks = new Set<ReturnType<typeof setTimeout>>();

beforeAll(async () => {
  vi.stubGlobal('requestIdleCallback', (handler: (deadline: IdleDeadline) => void) => {
    const id = setTimeout(() => {
      pendingIdleCallbacks.delete(id);
      handler({ didTimeout: false, timeRemaining: () => 0 } as IdleDeadline);
    }, 1);
    pendingIdleCallbacks.add(id);
    return id as unknown as number;
  });
  vi.stubGlobal('cancelIdleCallback', (id: number) => {
    clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
    pendingIdleCallbacks.delete(id as unknown as ReturnType<typeof setTimeout>);
  });
  vi.stubGlobal('DragEvent', class DragEvent extends Event {});
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class IntersectionObserver {
    readonly root = null;
    readonly rootMargin = '0px';
    readonly thresholds = [0];
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
  ({ attachKernelShortcuts } = await import('../src/services/notebookShortcuts'));
  ({ deriveKernelChipViewModel } = await import('../src/services/sessionContext'));
  ({ buildNotebook } = await import('../src/services/buildNotebook'));
  ({ NotebookActions } = await import('@jupyterlab/notebook'));
});

/** Only the two surfaces the shortcut path reads: readiness, and the two runs. */
class FakeSession {
  readonly statusChanged = new Signal<FakeSession, KernelStatus>(this);
  readonly calls: string[] = [];
  status: KernelStatus = 'idle';

  get kernelChipViewModel() {
    return deriveKernelChipViewModel(this.status, 'Python 3 (ipykernel)');
  }

  runAndAdvance() { this.calls.push('runAndAdvance'); return Promise.resolve(true); }
  runActive() { this.calls.push('runActive'); return Promise.resolve(true); }
}

interface Harness {
  notebook: Notebook;
  session: FakeSession | null;
  /** Presses a key on the notebook node; returns whether the default was suppressed. */
  press: (key: string, modifiers?: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }) => boolean;
  destroy: () => void;
}

function mount(options: { session?: FakeSession | null; readOnly?: boolean } = {}): Harness {
  const built = buildNotebook(notebookContent, { readOnly: false });
  const session = options.session === undefined ? new FakeSession() : options.session;
  attachKernelShortcuts(built.notebook, {
    getSessionContext: () => session as unknown as SessionContextManager | null,
    isReadOnly: () => options.readOnly === true,
    onError: () => {},
    requestConfirm: () => {},
  });

  return {
    notebook: built.notebook,
    session,
    press: (key, modifiers = {}) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers });
      built.notebook.node.dispatchEvent(event);
      return event.defaultPrevented;
    },
    destroy: () => {
      for (const id of pendingIdleCallbacks) clearTimeout(id);
      pendingIdleCallbacks.clear();
      built.dispose();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('attachKernelShortcuts run readiness', () => {
  it('runs the active cell only when the kernel is ready, matching the run buttons', () => {
    const harness = mount();
    harness.notebook.activeCellIndex = 0;

    harness.press('Enter', { shiftKey: true });
    harness.press('Enter', { ctrlKey: true });
    expect(harness.session!.calls).toEqual(['runAndAdvance', 'runActive']);

    // Every state the chip reports as not-ready is a state the shortcut must
    // not execute in either -- the button beside it is disabled in all of them.
    for (const status of ['dead', 'starting', 'terminating', 'unknown'] as KernelStatus[]) {
      harness.session!.status = status;
      expect(harness.press('Enter', { shiftKey: true })).toBe(true);
      expect(harness.press('Enter', { metaKey: true })).toBe(true);
    }
    expect(harness.session!.calls).toEqual(['runAndAdvance', 'runActive']);

    harness.destroy();
  });

  it('renders a markdown cell with no kernel at all, the way its run button does', () => {
    const harness = mount({ session: null });
    const runAndAdvance = vi.spyOn(NotebookActions, 'runAndAdvance').mockResolvedValue(true);
    const run = vi.spyOn(NotebookActions, 'run').mockResolvedValue(true);

    // Markdown renders in the browser, so edit-only mode is no obstacle.
    harness.notebook.activeCellIndex = 1;
    harness.press('Enter', { shiftKey: true });
    expect(runAndAdvance).toHaveBeenCalledTimes(1);
    harness.press('Enter', { metaKey: true });
    expect(run).toHaveBeenCalledTimes(1);

    // A code cell has nothing to render and no kernel to run on.
    harness.notebook.activeCellIndex = 0;
    harness.press('Enter', { shiftKey: true });
    expect(runAndAdvance).toHaveBeenCalledTimes(1);

    runAndAdvance.mockRestore();
    run.mockRestore();
    harness.destroy();
  });

  it('never runs while the host is read-only', () => {
    const harness = mount({ readOnly: true });
    harness.notebook.activeCellIndex = 0;

    harness.press('Enter', { shiftKey: true });
    harness.press('Enter', { metaKey: true });
    expect(harness.session!.calls).toEqual([]);

    harness.destroy();
  });
});

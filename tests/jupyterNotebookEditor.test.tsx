// @vitest-environment jsdom

/**
 * The editor component's host wiring.
 *
 * `NotebookToolbar` and `CellChrome` have their own suites; what is covered
 * here is the thing neither of them can see -- that a live `host.readOnly`
 * flip actually reaches them. An embedded notebook switches between view and
 * edit mode without remounting, so a read-only signal that only touched the
 * Jupyter model would leave the chrome mounted and the toolbar clickable.
 *
 * The kernel never starts: `resolveServerConfig()` finds no extension context
 * in a test, so the editor settles into edit-only mode, which is exactly the
 * state this asserts against.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

// React 18 refuses to run `act` without this opt-in flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type EditorModule = typeof import('../src/components/JupyterNotebookEditor');

let JupyterNotebookEditor: EditorModule['JupyterNotebookEditor'];

/**
 * `Notebook` schedules windowed rendering on an idle callback and never cancels
 * it on dispose, so jsdom's `setTimeout` polyfill fires into a disposed layout
 * after a test ends. Owning the queue here lets the teardown drain it first.
 */
const pendingIdleCallbacks = new Set<ReturnType<typeof setTimeout>>();

const NOTEBOOK_JSON = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: 'first',
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: 'print("first")',
      outputs: [],
    },
    { id: 'second', cell_type: 'markdown', metadata: {}, source: '# heading' },
  ],
});

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
  ({ JupyterNotebookEditor } = await import('../src/components/JupyterNotebookEditor'));
});

/**
 * The reactive shape of a host that can flip read-only: `readOnly` is read back
 * off the host every time, and subscribers hear about the flip. Written as a
 * class on purpose -- the host's methods are its own, so an editor that detaches
 * `onReadOnlyChanged` from its receiver would fail here the way it would in a
 * real embed frame.
 */
class FakeEmbedHost {
  readonly filePath = '/tmp/read-only.ipynb';
  readonly fileName = 'read-only.ipynb';
  readonly theme = 'Nimbalyst Light';
  readonly isActive = true;
  readOnly = false;

  private readonly readOnlyListeners = new Set<(value: boolean) => void>();

  onReadOnlyChanged(callback: (value: boolean) => void): () => void {
    this.readOnlyListeners.add(callback);
    return () => {
      this.readOnlyListeners.delete(callback);
    };
  }

  setReadOnly(value: boolean): void {
    this.readOnly = value;
    for (const listener of [...this.readOnlyListeners]) listener(value);
  }

  onThemeChanged(): () => void { return () => {}; }
  loadContent(): Promise<string> { return Promise.resolve(NOTEBOOK_JSON); }
  onFileChanged(): () => void { return () => {}; }
  setDirty(): void {}
  saveContent(): Promise<void> { return Promise.resolve(); }
  onSaveRequested(): () => void { return () => {}; }
  openHistory(): void {}
  registerEditorAPI(): void {}
  registerMenuItems(): void {}
  setEditorContextItems(): void {}
}

interface Harness {
  host: FakeEmbedHost;
  /** Cell chrome hosts currently mounted, across every rendered cell. */
  chromeCount: () => number;
  chromedCells: () => number;
  button: (name: string) => HTMLButtonElement;
  destroy: () => void;
}

async function mountEditor(): Promise<Harness> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const host = new FakeEmbedHost();
  let root: Root | null = null;

  await act(async () => {
    root = createRoot(container);
    root.render(<JupyterNotebookEditor host={host as never} />);
    await Promise.resolve();
  });
  // Two more flushes: `loadContent` resolves, then `applyContent` builds the
  // notebook and the kernel probe settles into edit-only mode.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  return {
    host,
    chromeCount: () => document.querySelectorAll('.jupyter-cell-chrome').length,
    chromedCells: () => document.querySelectorAll('.jupyter-cell--chromed').length,
    button: (name) => {
      const match = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.getAttribute('aria-label') === name);
      if (!match) throw new Error(`No control named "${name}" in [${
        [...container.querySelectorAll<HTMLButtonElement>('button')]
          .map((button) => button.getAttribute('aria-label')).join(', ')
      }]`);
      return match;
    },
    destroy: () => {
      act(() => root?.unmount());
      container.remove();
      for (const id of pendingIdleCallbacks) clearTimeout(id);
      pendingIdleCallbacks.clear();
    },
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('JupyterNotebookEditor read-only transitions', () => {
  it('unmounts the cell chrome and disables the toolbar when the host flips read-only', async () => {
    const harness = await mountEditor();

    expect(harness.chromeCount()).toBeGreaterThan(0);
    expect(harness.button('Insert code cell below').disabled).toBe(false);
    expect(harness.button('Insert markdown cell below').disabled).toBe(false);

    act(() => harness.host.setReadOnly(true));

    // Criterion 3: cell-scoped chrome is absent when the host is read-only --
    // not merely inert, and not only when it was read-only at mount.
    expect(harness.chromeCount()).toBe(0);
    expect(harness.chromedCells()).toBe(0);
    expect(harness.button('Insert code cell below').disabled).toBe(true);
    expect(harness.button('Insert markdown cell below').disabled).toBe(true);

    // ...and back: an embed that returns to edit mode is editable again.
    act(() => harness.host.setReadOnly(false));

    expect(harness.chromeCount()).toBeGreaterThan(0);
    expect(harness.button('Insert code cell below').disabled).toBe(false);

    harness.destroy();
  });
});

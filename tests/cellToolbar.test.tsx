// @vitest-environment jsdom

/**
 * Per-cell chrome.
 *
 * The notebook is a real `buildNotebook` widget, so every action asserts
 * against actual `NotebookActions` behaviour through the indexed helpers in
 * `notebookCellActions`. The chrome mounts itself into each cell's own DOM node
 * via a portal, so the assertions here reach into `notebook.widgets[i].node`
 * rather than the React container. No testing-library: the repo has none, and
 * react-dom's `act` is what the other component tests use.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Signal } from '@lumino/signaling';
import type * as nbformat from '@jupyterlab/nbformat';
import type { Notebook } from '@jupyterlab/notebook';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import type { RequestConfirm } from '../src/components/ConfirmDialog';
import type { KernelStatus, SessionContextManager } from '../src/services/sessionContext';
import type { CellFreshness } from '../src/services/stalenessTracker';

// React 18 refuses to run `act` without this opt-in flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ChromeModule = typeof import('../src/components/CellToolbar');
type SessionModule = typeof import('../src/services/sessionContext');

let CellChrome: ChromeModule['CellChrome'];
let deriveKernelChipViewModel: SessionModule['deriveKernelChipViewModel'];
let buildNotebook: typeof import('../src/services/buildNotebook').buildNotebook;
let StalenessTracker: typeof import('../src/services/stalenessTracker').StalenessTracker;
// Loaded dynamically like everything else here: importing it statically pulls in
// `@lumino/dragdrop`, which touches `DragEvent` before the stub below exists.
let Widget: typeof import('@lumino/widgets').Widget;

const notebookContent: nbformat.INotebookContent = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: 'first',
      cell_type: 'code',
      metadata: {},
      execution_count: 2,
      source: 'print("first")',
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'first\n' }],
    },
    { id: 'second', cell_type: 'markdown', metadata: {}, source: '# heading' },
    {
      id: 'third',
      cell_type: 'code',
      metadata: {},
      execution_count: null,
      source: 'answer = 42',
      outputs: [],
    },
  ],
};

/**
 * `Notebook` schedules windowed rendering on an idle callback and never cancels
 * it on dispose, so jsdom's `setTimeout` polyfill fires into a disposed layout
 * after a test ends. Owning the queue here lets `destroy()` drain it first.
 */
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
  ({ CellChrome } = await import('../src/components/CellToolbar'));
  ({ deriveKernelChipViewModel } = await import('../src/services/sessionContext'));
  ({ buildNotebook } = await import('../src/services/buildNotebook'));
  ({ StalenessTracker } = await import('../src/services/stalenessTracker'));
  ({ Widget } = await import('@lumino/widgets'));
});

/** Stand-in for `SessionContextManager`: only what the chrome actually reads. */
class FakeSession {
  readonly statusChanged = new Signal<FakeSession, KernelStatus>(this);
  readonly runs: number[] = [];
  status: KernelStatus = 'idle';

  get kernelChipViewModel() {
    return deriveKernelChipViewModel(this.status, 'Python 3 (ipykernel)');
  }

  setStatus(status: KernelStatus) {
    this.status = status;
    this.statusChanged.emit(status);
  }

  runCell(_notebook: Notebook, index: number) {
    this.runs.push(index);
    return Promise.resolve(true);
  }
}

interface Harness {
  session: FakeSession;
  notebook: Notebook;
  staleness: InstanceType<typeof StalenessTracker>;
  errors: string[];
  confirms: { message: string; confirmLabel?: string; onConfirm: () => void }[];
  acceptConfirm: () => Promise<void>;
  /** The chrome layer inside a cell's own node, or null when none is mounted. */
  chrome: (index: number) => HTMLElement | null;
  toolbar: (index: number) => HTMLElement | null;
  gutter: (index: number) => HTMLElement | null;
  /** Direct toolbar controls of one cell, in DOM order, by accessible name. */
  controlNames: (index: number) => string[];
  button: (index: number, name: string) => HTMLButtonElement;
  hover: (index: number | null) => void;
  setActive: (index: number) => void;
  openMenu: (index: number, triggerName: string) => Promise<void>;
  menuItems: () => HTMLButtonElement[];
  menuItem: (label: string) => HTMLButtonElement;
  click: (element: HTMLElement) => Promise<void>;
  rerender: () => void;
  destroy: () => void;
}

interface HarnessOptions {
  readOnly?: boolean;
  session?: FakeSession | null;
  /** Replaces the real tracker; the gutter only ever calls `getFreshness`. */
  freshness?: (id: string) => CellFreshness;
}

function mount(options: HarnessOptions = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const built = buildNotebook(notebookContent, { readOnly: false });
  const notebook = built.notebook;
  Widget.attach(notebook, document.body);
  /**
   * The windowed panel places cell nodes during a measure pass that needs real
   * layout, which jsdom never provides -- so `notebook.node` stays empty here
   * even though the widgets exist. Hover routing walks up from a cell node to
   * the notebook node, so the nodes are parented by hand instead. Only the DOM
   * shape is faked; the widgets and their models are real.
   */
  const materialize = () => {
    for (const cell of notebook.widgets) {
      if (!notebook.node.contains(cell.node)) notebook.node.appendChild(cell.node);
    }
  };
  materialize();
  const staleness = options.freshness
    ? ({ getFreshness: (id: string) => options.freshness!(id) } as unknown as InstanceType<typeof StalenessTracker>)
    : new StalenessTracker(notebook);
  const session = options.session === undefined ? new FakeSession() : options.session;
  const errors: string[] = [];
  const confirms: { message: string; confirmLabel?: string; onConfirm: () => void }[] = [];
  const requestConfirm: RequestConfirm = (request) => confirms.push(request);
  let root: Root | null = null;

  const render = () => {
    act(() => {
      root ??= createRoot(container);
      root.render(
        <CellChrome
          notebook={notebook}
          sessionContext={session as unknown as SessionContextManager | null}
          staleness={staleness}
          readOnly={options.readOnly === true}
          requestConfirm={requestConfirm}
          onError={(message) => errors.push(message)}
        />,
      );
    });
  };

  const chrome = (index: number) =>
    notebook.widgets[index]?.node.querySelector<HTMLElement>('.jupyter-cell-chrome') ?? null;

  const harness: Harness = {
    session: session as FakeSession,
    notebook,
    staleness,
    errors,
    confirms,
    acceptConfirm: async () => {
      const pending = confirms[confirms.length - 1];
      await act(async () => {
        pending.onConfirm();
        await Promise.resolve();
      });
    },
    chrome,
    toolbar: (index) => chrome(index)?.querySelector<HTMLElement>('[role="toolbar"]') ?? null,
    gutter: (index) => chrome(index)?.querySelector<HTMLElement>('.jupyter-cell-gutter') ?? null,
    controlNames: (index) =>
      [...(harness.toolbar(index)?.querySelectorAll<HTMLButtonElement>(':scope > button') ?? [])]
        .map(accessibleName),
    button: (index, name) => {
      const match = [...(harness.toolbar(index)?.querySelectorAll<HTMLButtonElement>('button') ?? []),
        ...(harness.gutter(index)?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
        .find((button) => accessibleName(button) === name);
      if (!match) throw new Error(`No cell ${index} control named "${name}" in [${
        harness.controlNames(index).join(', ')
      }]`);
      return match;
    },
    hover: (index) => {
      materialize();
      act(() => {
        if (index === null) {
          notebook.node.dispatchEvent(new MouseEvent('mouseleave'));
          return;
        }
        notebook.widgets[index].node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
    },
    setActive: (index) => {
      act(() => {
        notebook.activeCellIndex = index;
      });
    },
    openMenu: (index, triggerName) => harness.click(harness.button(index, triggerName)),
    menuItems: () => [...document.querySelectorAll<HTMLButtonElement>('[role="menu"] .jupyter-menu__item')],
    menuItem: (label) => {
      const match = harness.menuItems().find((item) => item.textContent?.startsWith(label));
      if (!match) throw new Error(`No menu item "${label}" in [${
        harness.menuItems().map((item) => item.textContent).join(', ')
      }]`);
      return match;
    },
    click: async (element) => {
      await act(async () => {
        element.click();
        await Promise.resolve();
      });
    },
    rerender: render,
    destroy: () => {
      act(() => root?.unmount());
      container.remove();
      Widget.detach(notebook);
      staleness.dispose?.();
      for (const id of pendingIdleCallbacks) clearTimeout(id);
      pendingIdleCallbacks.clear();
      built.dispose();
    },
  } as Harness;

  render();
  return harness;
}

/** `aria-label` wins over text content, the same way an AT would resolve it. */
function accessibleName(button: HTMLButtonElement): string {
  return button.getAttribute('aria-label') ?? (button.textContent ?? '').trim();
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('CellChrome layout', () => {
  it('puts six direct controls plus overflow on the pointed-at cell only', () => {
    const harness = mount();
    harness.setActive(0);

    expect(harness.toolbar(0)).not.toBeNull();
    expect(harness.toolbar(0)?.getAttribute('aria-label')).toBe('Cell actions');
    expect(harness.controlNames(0)).toEqual([
      'Run this cell',
      'Cell type: Code',
      'Move cell up',
      'Move cell down',
      'Duplicate cell',
      'More cell actions',
      'Delete cell',
    ]);

    // Cells the user is not on carry no toolbar at all.
    expect(harness.toolbar(1)).toBeNull();
    expect(harness.toolbar(2)).toBeNull();

    harness.hover(2);
    expect(harness.toolbar(2)).not.toBeNull();

    harness.destroy();
  });

  it('gives every icon-only control both a title and an aria-label', () => {
    const harness = mount();
    harness.setActive(0);

    const iconOnly = [
      ...harness.toolbar(0)!.querySelectorAll<HTMLButtonElement>('button'),
      ...harness.gutter(0)!.querySelectorAll<HTMLButtonElement>('button'),
    ].filter((button) => (button.textContent ?? '').trim() === '');
    expect(iconOnly.length).toBeGreaterThan(0);
    for (const button of iconOnly) {
      expect(button.getAttribute('title')).toBeTruthy();
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }

    harness.destroy();
  });

  it('mounts no chrome at all when the host is read-only', () => {
    const harness = mount({ readOnly: true });
    harness.setActive(0);
    harness.hover(0);

    expect(document.querySelectorAll('.jupyter-cell-chrome')).toHaveLength(0);
    // ...and JupyterLab's own execution prompt is left alone, since nothing
    // replaces it in this mode.
    expect(document.querySelectorAll('.jupyter-cell--chromed')).toHaveLength(0);

    harness.destroy();
  });

  it('tears every host back out on unmount', () => {
    const harness = mount();
    expect(document.querySelectorAll('.jupyter-cell-chrome')).toHaveLength(3);

    act(() => harness.destroy());
    expect(document.querySelectorAll('.jupyter-cell-chrome')).toHaveLength(0);
    expect(document.querySelectorAll('.jupyter-cell--chromed')).toHaveLength(0);
  });

  /**
   * A cell whose node JupyterLab rebuilt underneath us gets a fresh host, and
   * the node it left behind has to be handed back clean. `jupyter-cell--chromed`
   * hides that node's own `jp-InputPrompt`, so a leftover class on a recycled
   * node would leave a cell with no execution count and no chrome to replace it.
   */
  it('un-marks the node it abandons when a cell is rebuilt underneath it', () => {
    const harness = mount();
    const cell = harness.notebook.widgets[0];
    const abandoned = cell.node;

    // Stand in for the rebuild: the host is still parented to the old node,
    // which is no longer the cell's.
    act(() => {
      const replacement = document.createElement('div');
      replacement.className = abandoned.className;
      Object.defineProperty(cell, 'node', { value: replacement, configurable: true });
      // Re-scan, the way any cell list or active cell change does.
      harness.notebook.activeCellIndex = 1;
    });

    expect(abandoned.classList.contains('jupyter-cell--chromed')).toBe(false);
    expect(abandoned.querySelectorAll('.jupyter-cell-chrome')).toHaveLength(0);
    expect(cell.node.querySelectorAll('.jupyter-cell-chrome')).toHaveLength(1);
    expect(cell.node.classList.contains('jupyter-cell--chromed')).toBe(true);

    harness.destroy();
  });

  it('keeps exactly one host per cell across inserts and deletes', async () => {
    const harness = mount();
    harness.setActive(0);
    const hosts = () => harness.notebook.widgets
      .map((cell) => cell.node.querySelectorAll('.jupyter-cell-chrome').length);

    await harness.click(harness.button(0, 'Duplicate cell'));
    expect(harness.notebook.widgets).toHaveLength(4);
    expect(hosts()).toEqual([1, 1, 1, 1]);

    // A deleted cell's node has to be handed back clean: leaking one host per
    // removed cell is the failure mode this whole layer risks.
    // Duplicating leaves the copy active, so the chrome has moved with it.
    harness.setActive(0);
    const doomed = harness.notebook.widgets[0].node;
    await harness.click(harness.button(0, 'Delete cell'));
    await harness.acceptConfirm();
    expect(harness.notebook.widgets).toHaveLength(3);
    expect(hosts()).toEqual([1, 1, 1]);
    expect(doomed.querySelectorAll('.jupyter-cell-chrome')).toHaveLength(0);
    expect(doomed.classList.contains('jupyter-cell--chromed')).toBe(false);

    harness.destroy();
  });
});

describe('CellChrome capabilities', () => {
  it('disables the moves and merges that do not apply to this cell', async () => {
    const harness = mount();

    harness.hover(0);
    expect(harness.button(0, 'Move cell up').disabled).toBe(true);
    expect(harness.button(0, 'Move cell down').disabled).toBe(false);
    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItem('Merge with cell above').disabled).toBe(true);
    expect(harness.menuItem('Merge with cell below').disabled).toBe(false);
    await harness.click(harness.menuItem('Merge with cell below'));

    harness.destroy();
  });

  it('disables the last cell down-move and its merge-below', async () => {
    const harness = mount();

    harness.hover(2);
    expect(harness.button(2, 'Move cell up').disabled).toBe(false);
    expect(harness.button(2, 'Move cell down').disabled).toBe(true);
    await harness.openMenu(2, 'More cell actions');
    expect(harness.menuItem('Merge with cell above').disabled).toBe(false);
    expect(harness.menuItem('Merge with cell below').disabled).toBe(true);

    harness.destroy();
  });

  it('offers clear-output only where there is output to clear', async () => {
    const harness = mount();

    harness.hover(0);
    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItem('Clear output').disabled).toBe(false);
    await harness.click(harness.menuItem('Clear output'));
    expect((harness.notebook.widgets[0].model as unknown as { outputs: { length: number } }).outputs.length)
      .toBe(0);

    // The same cell, now empty of output, cannot be cleared again.
    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItem('Clear output').disabled).toBe(true);

    harness.destroy();
  });

  it('keeps the output toggles off markdown cells', async () => {
    const harness = mount();

    harness.hover(1);
    await harness.openMenu(1, 'More cell actions');
    expect(harness.menuItem('Collapse input').disabled).toBe(false);
    expect(harness.menuItem('Collapse output').disabled).toBe(true);
    expect(harness.menuItem('Scroll output').disabled).toBe(true);

    harness.destroy();
  });
});

describe('CellChrome overflow menu', () => {
  it('labels the collapse and scroll rows by what they will do next', async () => {
    const harness = mount();
    harness.hover(0);

    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItems().map((item) => item.textContent?.replace(/(⌃⇧−|⇧M|A|B)$/, ''))).toEqual([
      'Split cell at cursor',
      'Merge with cell above',
      'Merge with cell below',
      'Clear output',
      'Collapse input',
      'Collapse output',
      'Scroll output',
      'Insert cell above',
      'Insert cell below',
    ]);

    await harness.click(harness.menuItem('Collapse input'));
    expect((harness.notebook.widgets[0] as unknown as { inputHidden: boolean }).inputHidden).toBe(true);

    // The row now names the way back out, which the old bare `Input` button
    // never did.
    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItem('Expand input')).toBeTruthy();
    await harness.click(harness.menuItem('Expand input'));
    expect((harness.notebook.widgets[0] as unknown as { inputHidden: boolean }).inputHidden).toBe(false);

    harness.destroy();
  });

  it('flips the output and scroll rows the same way', async () => {
    const harness = mount();
    harness.hover(0);
    const cell = harness.notebook.widgets[0] as unknown as {
      outputHidden: boolean;
      outputsScrolled: boolean;
    };

    await harness.openMenu(0, 'More cell actions');
    await harness.click(harness.menuItem('Collapse output'));
    expect(cell.outputHidden).toBe(true);
    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItem('Expand output')).toBeTruthy();

    await harness.click(harness.menuItem('Scroll output'));
    expect(cell.outputsScrolled).toBe(true);
    await harness.openMenu(0, 'More cell actions');
    expect(harness.menuItem('Stop scrolling output')).toBeTruthy();

    harness.destroy();
  });

  it('inserts above and below the cell being pointed at, not the active one', async () => {
    const harness = mount();
    harness.setActive(0);
    harness.hover(2);

    await harness.openMenu(2, 'More cell actions');
    await harness.click(harness.menuItem('Insert cell above'));

    expect(harness.notebook.widgets).toHaveLength(4);
    expect(harness.notebook.widgets[2].model.sharedModel.getSource()).toBe('');
    expect(harness.notebook.widgets[3].model.sharedModel.getSource()).toBe('answer = 42');

    harness.destroy();
  });
});

describe('CellChrome direct actions', () => {
  it('moves, duplicates and deletes the cell it is attached to', async () => {
    const harness = mount();
    // The active cell is deliberately elsewhere: the old global row acted on
    // the selection, this acts on the cell the control is drawn on.
    harness.setActive(0);
    harness.hover(2);

    await harness.click(harness.button(2, 'Move cell up'));
    expect(harness.notebook.widgets.map((cell) => cell.model.sharedModel.getSource())).toEqual([
      'print("first")',
      'answer = 42',
      '# heading',
    ]);

    harness.hover(1);
    await harness.click(harness.button(1, 'Duplicate cell'));
    expect(harness.notebook.widgets.map((cell) => cell.model.sharedModel.getSource())).toEqual([
      'print("first")',
      'answer = 42',
      'answer = 42',
      '# heading',
    ]);

    harness.hover(1);
    await harness.click(harness.button(1, 'Delete cell'));
    expect(harness.confirms[0].message).toBe('Delete this notebook cell?');
    // Declining leaves the notebook exactly as it was.
    expect(harness.notebook.widgets).toHaveLength(4);
    await harness.acceptConfirm();
    expect(harness.notebook.widgets).toHaveLength(3);

    harness.destroy();
  });

  it('retypes the cell from its own type menu', async () => {
    const harness = mount();
    harness.hover(2);

    expect(harness.button(2, 'Cell type: Code')).toBeTruthy();
    await harness.openMenu(2, 'Cell type: Code');
    const rows = harness.menuItems();
    expect(rows.map((row) => row.textContent)).toEqual(['Code', 'Markdown', 'Raw']);
    expect(rows[0].getAttribute('role')).toBe('menuitemradio');
    expect(rows[0].getAttribute('aria-checked')).toBe('true');

    await harness.click(rows[1]);
    expect(harness.notebook.widgets[2].model.type).toBe('markdown');
    // The type change must carry the source over rather than reset the cell.
    expect(harness.notebook.widgets[2].model.sharedModel.getSource()).toBe('answer = 42');

    harness.destroy();
  });

  it('does not pull the caret out of the cell editor', () => {
    const harness = mount();
    harness.hover(0);

    // Disabled controls are skipped: React does not dispatch mouse events to
    // them at all, so there would be nothing to assert.
    for (const button of harness.toolbar(0)!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')) {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      button.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }

    harness.destroy();
  });
});

describe('CellChrome run controls', () => {
  it('runs the cell it is attached to, from the toolbar and the gutter', async () => {
    const harness = mount();
    harness.setActive(0);
    harness.hover(2);

    await harness.click(harness.button(2, 'Run this cell'));
    expect(harness.session.runs).toEqual([2]);

    // The gutter run button carries the same accessible name, so both are
    // covered by looking them up together.
    const runButtons = [
      ...harness.toolbar(2)!.querySelectorAll<HTMLButtonElement>('button'),
      ...harness.gutter(2)!.querySelectorAll<HTMLButtonElement>('button'),
    ].filter((button) => button.getAttribute('aria-label') === 'Run this cell');
    expect(runButtons).toHaveLength(2);
    await harness.click(runButtons[1]);
    expect(harness.session.runs).toEqual([2, 2]);

    harness.destroy();
  });

  // The rule is `canRunCell`, shared with the top toolbar's Run and with
  // Shift+Enter: only a code cell needs a kernel. Rendering markdown asks the
  // kernel for nothing, so disabling it in edit-only mode would grey out an
  // action that works -- the deliberate exception to "no runtime, no running".
  it('disables run for code cells with no kernel, but still renders markdown', () => {
    const harness = mount({ session: null });
    harness.hover(0);

    expect(harness.button(0, 'Run this cell').disabled).toBe(true);

    harness.hover(1);
    expect(harness.button(1, 'Run this cell').disabled).toBe(false);

    harness.destroy();
  });

  it('follows the kernel back to ready', () => {
    const harness = mount();
    harness.hover(0);
    expect(harness.button(0, 'Run this cell').disabled).toBe(false);

    act(() => harness.session.setStatus('dead'));
    expect(harness.button(0, 'Run this cell').disabled).toBe(true);

    act(() => harness.session.setStatus('idle'));
    expect(harness.button(0, 'Run this cell').disabled).toBe(false);

    harness.destroy();
  });
});

describe('CellChrome gutter', () => {
  it('shows the execution count for code cells only, with the run button on hover', () => {
    const harness = mount();

    expect(harness.gutter(0)?.textContent).toBe('[2]');
    expect(harness.gutter(1)).toBeNull();
    expect(harness.gutter(2)?.textContent).toBe('[ ]');

    // The run button is hover-scoped; the count is not.
    expect(harness.gutter(2)!.querySelectorAll('button')).toHaveLength(0);
    harness.hover(2);
    expect(harness.gutter(2)!.querySelectorAll('button')).toHaveLength(1);

    harness.destroy();
  });

  it('separates "edited since it ran" from "ran before this session"', () => {
    const freshness = (id: string): CellFreshness => {
      if (id === 'first') return { stale: true, executedBeforeRestart: false };
      if (id === 'third') return { stale: null, executedBeforeRestart: null };
      return { stale: false, executedBeforeRestart: false };
    };
    const harness = mount({ freshness });

    const count = (index: number) =>
      harness.gutter(index)?.querySelector('.jupyter-cell-gutter__count')?.getAttribute('data-freshness');
    expect(count(0)).toBe('stale');
    // Cell three has no execution count either, so it is not merely unknowable
    // -- it has never run at all, and says so.
    expect(count(2)).toBe('never');
    expect(
      harness.gutter(0)?.querySelector('.jupyter-cell-gutter__count')?.getAttribute('title'),
    ).toBe('Edited since it last ran');

    harness.destroy();
  });

  it('reports a kernel restart separately from a source edit', () => {
    const harness = mount({
      freshness: () => ({ stale: false, executedBeforeRestart: true }),
    });

    expect(
      harness.gutter(0)?.querySelector('.jupyter-cell-gutter__count')?.getAttribute('data-freshness'),
    ).toBe('restarted');

    harness.destroy();
  });
});

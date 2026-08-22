// @vitest-environment jsdom

/**
 * The top toolbar.
 *
 * The notebook is a real `buildNotebook` widget so insert/undo/redo assert
 * against actual `NotebookActions` behaviour, while the kernel side is a stub
 * manager -- there is no server here, and the toolbar only ever reads the same
 * four surfaces (`statusChanged`, `runProgressChanged`, `kernelChipViewModel`,
 * `listKernels`) that Wave 1 fixed. No testing-library: the repo has none, and
 * react-dom's `act` is what the other component tests use.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Signal } from '@lumino/signaling';
import type * as nbformat from '@jupyterlab/nbformat';
import type { NotebookActions as NotebookActionsType, Notebook } from '@jupyterlab/notebook';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import type { RequestConfirm } from '../src/components/ConfirmDialog';
import type {
  KernelSpecOption,
  KernelStatus,
  RunProgress,
  SessionContextManager,
} from '../src/services/sessionContext';

// React 18 refuses to run `act` without this opt-in flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ToolbarModule = typeof import('../src/components/NotebookToolbar');
type SessionModule = typeof import('../src/services/sessionContext');

let NotebookToolbar: ToolbarModule['NotebookToolbar'];
let deriveKernelChipViewModel: SessionModule['deriveKernelChipViewModel'];
let buildNotebook: typeof import('../src/services/buildNotebook').buildNotebook;
// Loaded dynamically like everything else here: importing it statically pulls in
// `@lumino/dragdrop`, which touches `DragEvent` before the stub below exists.
let NotebookActions: typeof NotebookActionsType;

const notebookContent: nbformat.INotebookContent = {
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
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'first\n' }],
    },
    {
      id: 'second',
      cell_type: 'markdown',
      metadata: {},
      source: '# heading',
    },
  ],
};

const KERNEL_SPECS: KernelSpecOption[] = [
  { name: 'python3', displayName: 'Python 3 (ipykernel)', language: 'python' },
  { name: 'deno', displayName: 'Deno', language: 'typescript' },
];

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
  ({ NotebookToolbar } = await import('../src/components/NotebookToolbar'));
  ({ deriveKernelChipViewModel } = await import('../src/services/sessionContext'));
  ({ buildNotebook } = await import('../src/services/buildNotebook'));
  ({ NotebookActions } = await import('@jupyterlab/notebook'));
});

/**
 * Stand-in for `SessionContextManager`. Only the members the toolbar reads are
 * real; every action just records that it was called, since what is under test
 * is the wiring, not JupyterLab's execution.
 */
class FakeSession {
  readonly statusChanged = new Signal<FakeSession, KernelStatus>(this);
  readonly runProgressChanged = new Signal<FakeSession, RunProgress | null>(this);
  readonly calls: string[] = [];
  status: KernelStatus = 'idle';
  runProgress: RunProgress | null = null;
  kernelName: string | null = 'python3';
  kernelDisplayName = 'Python 3 (ipykernel)';
  restartResult = true;
  specs: KernelSpecOption[] = KERNEL_SPECS;
  readonly sessionContext = { session: { kernel: null } };

  get kernelChipViewModel() {
    return deriveKernelChipViewModel(
      this.status,
      this.status === 'no-kernel' ? null : this.kernelDisplayName,
      this.runProgress,
    );
  }

  listKernels() {
    return Promise.resolve(this.specs);
  }

  setStatus(status: KernelStatus) {
    this.status = status;
    this.statusChanged.emit(status);
  }

  setProgress(progress: RunProgress | null) {
    this.runProgress = progress;
    this.runProgressChanged.emit(progress);
  }

  private record<T>(name: string, value: T): Promise<T> {
    this.calls.push(name);
    return Promise.resolve(value);
  }

  runActive() { return this.record('runActive', true); }
  runAndAdvance() { return this.record('runAndAdvance', true); }
  runAll() { return this.record('runAll', true); }
  runAbove() { return this.record('runAbove', true); }
  runBelow() { return this.record('runBelow', true); }
  interrupt() { return this.record('interrupt', undefined); }
  restart() { return this.record('restart', this.restartResult); }
  restartAndRunAll() { return this.record('restartAndRunAll', true); }
  reconnect() { return this.record('reconnect', undefined); }
  shutdown() { return this.record('shutdown', undefined); }
  changeKernel(name: string) { return this.record(`changeKernel:${name}`, true); }
}

interface Harness {
  session: FakeSession;
  notebook: Notebook;
  container: HTMLElement;
  errors: string[];
  runtimeRequests: number;
  confirms: { message: string; confirmLabel?: string }[];
  /** Accept the pending confirmation, the way the dialog's confirm button does. */
  acceptConfirm: () => Promise<void>;
  render: () => void;
  /** Hand the toolbar a different manager, as re-initialising the kernel does. */
  swapSession: (next: FakeSession | null) => void;
  toolbar: () => HTMLElement;
  /** Direct toolbar controls, in DOM order, by accessible name. */
  controlNames: () => string[];
  button: (name: string) => HTMLButtonElement;
  chip: () => HTMLButtonElement;
  openMenu: (triggerName: string) => Promise<void>;
  menuItems: () => HTMLButtonElement[];
  menuItem: (label: string) => HTMLButtonElement;
  /** Click and flush: every toolbar action defers its work by a microtask. */
  click: (element: HTMLElement) => Promise<void>;
  destroy: () => void;
}

interface HarnessOptions {
  session?: FakeSession | null;
  notebook?: Notebook | null;
  readOnly?: boolean;
}

function mount(options: HarnessOptions = {}): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const built = buildNotebook(notebookContent, { readOnly: false });
  const notebook = options.notebook === undefined ? built.notebook : options.notebook;
  // Mutable: re-initialising the kernel hands the toolbar a different manager
  // while the old one may still have work in flight.
  let session = options.session === undefined ? new FakeSession() : options.session;
  const errors: string[] = [];
  const confirms: { message: string; confirmLabel?: string; onConfirm: () => void }[] = [];
  const harnessState = { runtimeRequests: 0 };

  const requestConfirm: RequestConfirm = (request) => confirms.push(request);
  let root: Root | null = null;

  const render = () => {
    act(() => {
      root ??= createRoot(container);
      root.render(
        <NotebookToolbar
          sessionContext={session as unknown as SessionContextManager | null}
          notebook={notebook}
          readOnly={options.readOnly === true}
          requestConfirm={requestConfirm}
          onError={(message) => errors.push(message)}
          onManageRuntime={() => { harnessState.runtimeRequests += 1; }}
          runtimeDescription="Managed local server · /usr/bin/python3"
        />,
      );
    });
  };

  const toolbar = () => container.querySelector<HTMLElement>('[role="toolbar"]')!;
  const click = async (element: HTMLElement) => {
    await act(async () => {
      element.click();
      await Promise.resolve();
    });
  };

  const harness: Harness = {
    session: session as FakeSession,
    notebook: notebook as Notebook,
    container,
    errors,
    get runtimeRequests() { return harnessState.runtimeRequests; },
    confirms,
    acceptConfirm: async () => {
      const pending = confirms[confirms.length - 1];
      await act(async () => {
        pending.onConfirm();
        await Promise.resolve();
      });
    },
    render,
    swapSession: (next: FakeSession | null) => {
      session = next;
      render();
    },
    toolbar,
    controlNames: () => [...toolbar().children]
      .flatMap((child) => (
        child instanceof HTMLButtonElement
          ? [child]
          : [...child.querySelectorAll<HTMLButtonElement>(':scope > button')]
      ))
      .map((button) => accessibleName(button)),
    button: (name) => {
      const match = [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => accessibleName(button) === name);
      if (!match) throw new Error(`No toolbar button named "${name}" in [${
        [...container.querySelectorAll<HTMLButtonElement>('button')].map(accessibleName).join(', ')
      }]`);
      return match;
    },
    chip: () => container.querySelector<HTMLButtonElement>('[data-testid="jupyter-toolbar-kernel-chip"]')!,
    openMenu: (triggerName) => click(harness.button(triggerName)),
    menuItems: () => [...container.querySelectorAll<HTMLButtonElement>('[role="menu"] .jupyter-menu__item')],
    menuItem: (label) => {
      const match = harness.menuItems().find((item) => item.textContent?.startsWith(label));
      if (!match) throw new Error(`No menu item "${label}" in [${
        harness.menuItems().map((item) => item.textContent).join(', ')
      }]`);
      return match;
    },
    click,
    destroy: () => {
      act(() => root?.unmount());
      container.remove();
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

/** Flush the `listKernels()` promise the mount effect kicks off. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
});


/** The chip's text is state, not identity; normalise it when comparing layout. */
function layoutOf(names: string[]): string[] {
  return names.map((name) => (name.startsWith('Kernel:') ? 'Kernel: <chip>' : name));
}

/**
 * Vitest stubs CSS imports, so the real rules are put into the document by
 * hand for the one assertion that is about them. Both files are needed: the
 * split button's own box comes from `Menu.css`, its pinned width from
 * `NotebookToolbar.css`.
 */
function installToolbarStyles(): void {
  const style = document.createElement('style');
  style.textContent = ['Menu.css', 'NotebookToolbar.css']
    .map((file) => readFileSync(resolve(process.cwd(), 'src/components', file), 'utf8'))
    .join('\n');
  document.head.appendChild(style);
}

describe('NotebookToolbar layout', () => {
  it('renders one toolbar row of six controls plus the overflow button', () => {
    const harness = mount();

    expect(harness.container.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(harness.toolbar().getAttribute('aria-label')).toBe('Notebook actions');
    expect(harness.controlNames()).toEqual([
      'Run',
      'Run options',
      'Restart',
      'Kernel options',
      'Insert code cell below',
      'Insert markdown cell below',
      'Kernel: Python 3 (ipykernel)',
      'More notebook actions',
    ]);

    // Run is the only tinted control in the row.
    const tinted = harness.container.querySelectorAll('.jupyter-split[data-tone="primary"]');
    expect(tinted).toHaveLength(1);
    expect(tinted[0].querySelector('.jupyter-split__main')?.textContent).toBe('Run');

    harness.destroy();
  });

  it('gives every icon-only control both a title and an aria-label', () => {
    const harness = mount();

    const iconOnly = [...harness.container.querySelectorAll<HTMLButtonElement>('[role="toolbar"] button')]
      .filter((button) => (button.textContent ?? '').trim() === '');
    expect(iconOnly.length).toBeGreaterThan(0);
    for (const button of iconOnly) {
      expect(button.getAttribute('title')).toBeTruthy();
      expect(button.getAttribute('aria-label')).toBeTruthy();
    }

    harness.destroy();
  });
});

describe('NotebookToolbar busy state', () => {
  it('swaps Run to Stop in place without moving any other control', async () => {
    const harness = mount();
    const idleOrder = harness.controlNames();

    act(() => harness.session.setStatus('busy'));

    const busyOrder = harness.controlNames();
    // Busy is a bare Stop, as the mockup draws it: the run caret goes away
    // rather than staying live, because "Run all cells" while a run-all is
    // already in flight only queues a second one. Restart does not move,
    // because the container's width is pinned -- see the test below.
    expect(layoutOf(busyOrder)).toEqual([
      'Stop',
      'Restart',
      'Kernel options',
      'Insert code cell below',
      'Insert markdown cell below',
      'Kernel: <chip>',
      'More notebook actions',
    ]);
    expect(harness.container.querySelectorAll('.jupyter-split[data-tone="danger"]')).toHaveLength(1);
    expect(harness.container.querySelectorAll('.jupyter-split[data-tone="primary"]')).toHaveLength(0);

    await harness.click(harness.button('Stop'));
    expect(harness.session.calls).toEqual(['interrupt']);

    // ...and back again when the kernel goes idle.
    act(() => harness.session.setStatus('idle'));
    expect(layoutOf(harness.controlNames())).toEqual(layoutOf(idleOrder));

    harness.destroy();
  });

  /**
   * Criterion 5 is a claim about pixels, and jsdom has no layout engine: every
   * `getBoundingClientRect()` in this file is a zero rect, so measuring the
   * Restart control before and after the swap would pass however far it moved.
   * What is asserted instead is the invariant that makes the geometry hold --
   * the Run/Stop container is pinned to one width by the real stylesheet, so
   * a wider label cannot push anything to its right.
   */
  it('pins Run and Stop to the same width so nothing to their right can shift', () => {
    installToolbarStyles();
    const harness = mount();
    const runControl = () =>
      harness.container.querySelector<HTMLElement>('[data-testid="jupyter-toolbar-run"]')!;
    const restart = () =>
      harness.container.querySelector<HTMLElement>('[data-testid="jupyter-toolbar-restart"]')!;

    const idleWidth = getComputedStyle(runControl()).width;
    // A content-sized control is exactly the bug: "Stop" is not "Run" wide.
    expect(idleWidth).toMatch(/^\d+(\.\d+)?px$/);
    // Restart itself stays content-sized; it is the neighbour that must not move.
    expect(getComputedStyle(restart()).width).not.toMatch(/^\d+(\.\d+)?px$/);

    act(() => harness.session.setStatus('busy'));
    expect(harness.button('Stop').textContent).toContain('Stop');
    expect(getComputedStyle(runControl()).width).toBe(idleWidth);

    act(() => harness.session.setStatus('idle'));
    expect(getComputedStyle(runControl()).width).toBe(idleWidth);

    harness.destroy();
  });

  it('reports run progress on the chip', () => {
    const harness = mount();

    act(() => {
      harness.session.setStatus('busy');
      harness.session.setProgress({ current: 4, total: 12 });
    });

    expect(harness.chip().textContent).toContain('Python 3 (ipykernel) · running cell 4 of 12');
    expect(harness.chip().getAttribute('data-status')).toBe('busy');

    act(() => {
      harness.session.setProgress(null);
      harness.session.setStatus('idle');
    });
    expect(harness.chip().textContent).toContain('Python 3 (ipykernel)');
    expect(harness.chip().textContent).not.toContain('running cell');

    harness.destroy();
  });
});

describe('NotebookToolbar run and restart menus', () => {
  it('runs and advances from the primary half, and reaches every run variant from the menu', async () => {
    const harness = mount();

    await harness.click(harness.button('Run'));
    expect(harness.session.calls).toEqual(['runAndAdvance']);

    const variants: [string, string][] = [
      ['Run cell and advance', 'runAndAdvance'],
      ['Run cell in place', 'runActive'],
      ['Run all cells', 'runAll'],
      ['Run all above', 'runAbove'],
      ['Run all below', 'runBelow'],
    ];
    for (const [label, call] of variants) {
      await harness.openMenu('Run options');
      await harness.click(harness.menuItem(label));
      expect(harness.session.calls[harness.session.calls.length - 1]).toBe(call);
    }

    // The menu teaches the shortcuts the old bar never did.
    await harness.openMenu('Run options');
    expect(harness.menuItem('Run cell and advance').querySelector('.jupyter-menu__shortcut')?.textContent)
      .toBe('⇧⏎');
    expect(harness.menuItem('Run cell in place').querySelector('.jupyter-menu__shortcut')?.textContent)
      .toBe('⌘⏎');

    harness.destroy();
  });

  /**
   * Run is the same action here, on the cell, and on Shift+Enter, so it is
   * gated by the same rule: the active cell decides, and only a code cell
   * needs a kernel. Without this the row disagreed with itself -- the button
   * greyed out on a markdown cell that its own tooltip's shortcut would run.
   */
  it('gates Run on the active cell, so markdown still runs with no kernel', async () => {
    const harness = mount({ session: null });
    const runAndAdvance = vi.spyOn(NotebookActions, 'runAndAdvance').mockResolvedValue(true);

    harness.notebook.activeCellIndex = 0;
    harness.render();
    expect(harness.button('Run').disabled).toBe(true);

    act(() => { harness.notebook.activeCellIndex = 1; });
    expect(harness.button('Run').disabled).toBe(false);

    await harness.click(harness.button('Run'));
    expect(runAndAdvance).toHaveBeenCalledWith(harness.notebook);

    // The kernel-wide rows are a different question and still answer no.
    await harness.openMenu('Run options');
    expect(harness.menuItem('Run cell and advance').disabled).toBe(false);
    expect(harness.menuItem('Run all cells').disabled).toBe(true);

    runAndAdvance.mockRestore();
    harness.destroy();
  });

  it('confirms before restart, restart-and-run-all, and restart-and-clear', async () => {
    const harness = mount();

    await harness.click(harness.button('Restart'));
    expect(harness.session.calls).toEqual([]);
    expect(harness.confirms[0].message).toContain('Restart the kernel?');
    await harness.acceptConfirm();
    expect(harness.session.calls).toEqual(['restart']);

    await harness.openMenu('Kernel options');
    await harness.click(harness.menuItem('Restart and run all'));
    expect(harness.confirms[1].message).toContain('run every cell');
    await harness.acceptConfirm();
    expect(harness.session.calls).toEqual(['restart', 'restartAndRunAll']);

    await harness.openMenu('Kernel options');
    await harness.click(harness.menuItem('Restart and clear outputs'));
    expect(harness.confirms[2].message).toContain('clear every saved cell output');
    // Declining is a real no-op: the kernel is untouched.
    expect(harness.session.calls).toEqual(['restart', 'restartAndRunAll']);
    await harness.acceptConfirm();
    expect(harness.session.calls).toEqual(['restart', 'restartAndRunAll', 'restart']);

    harness.destroy();
  });

  it('offers interrupt and a destructive shut down behind the restart caret', async () => {
    const harness = mount();

    await harness.openMenu('Kernel options');
    await harness.click(harness.menuItem('Interrupt'));
    expect(harness.session.calls).toEqual(['interrupt']);

    await harness.openMenu('Kernel options');
    const shutdown = harness.menuItem('Shut down kernel');
    expect(shutdown.getAttribute('data-danger')).toBe('true');
    await harness.click(shutdown);
    expect(harness.confirms[0].message).toContain('Shut down the kernel?');
    await harness.acceptConfirm();
    expect(harness.session.calls).toEqual(['interrupt', 'shutdown']);

    harness.destroy();
  });
});

describe('NotebookToolbar kernel chip', () => {
  it('lists kernels as radio rows and switches on select', async () => {
    const harness = mount();
    await settle();

    await harness.click(harness.chip());
    const rows = harness.menuItems();
    expect(rows.map((row) => row.textContent?.replace(/idle$/, ''))).toEqual([
      'Python 3 (ipykernel)',
      'Deno',
      'Runtime setup…',
      'Reconnect',
      'Kernel info',
    ]);
    expect(rows[0].getAttribute('role')).toBe('menuitemradio');
    expect(rows[0].getAttribute('aria-checked')).toBe('true');
    expect(rows[1].getAttribute('aria-checked')).toBe('false');
    expect(
      harness.container.querySelector('[role="menu"] .jupyter-menu__header')?.textContent,
    ).toBe('Kernel');

    await harness.click(rows[1]);
    expect(harness.session.calls).toEqual(['changeKernel:deno']);

    harness.destroy();
  });

  it('ignores a kernel list from a manager it has already been swapped off', async () => {
    const slow = new FakeSession();
    let deliver: (specs: KernelSpecOption[]) => void = () => {};
    slow.listKernels = () => new Promise<KernelSpecOption[]>((resolve) => { deliver = resolve; });

    const harness = mount({ session: slow });
    const replacement = new FakeSession();
    replacement.kernelDisplayName = 'Deno';
    replacement.kernelName = 'deno';
    replacement.specs = [{ name: 'deno', displayName: 'Deno', language: 'typescript' }];
    harness.swapSession(replacement);
    await settle();

    // The old manager finally answers -- for a server this toolbar no longer
    // talks to. Its list must not replace the one that is current.
    act(() => deliver(KERNEL_SPECS));
    await settle();

    await harness.click(harness.chip());
    expect(harness.menuItems().map((row) => row.textContent?.replace(/idle$/, ''))).toEqual([
      'Deno',
      'Runtime setup…',
      'Reconnect',
      'Kernel info',
    ]);

    harness.destroy();
  });

  it('reaches runtime setup and reconnect from the chip rather than the row', async () => {
    const harness = mount();
    await settle();

    // Reconnect is a menu row in every state; it never materialises mid-row and
    // shifts the controls to its right, the way the old conditional button did.
    expect(harness.controlNames()).not.toContain('Reconnect');
    act(() => harness.session.setStatus('dead'));
    expect(harness.controlNames()).not.toContain('Reconnect');
    expect(harness.chip().getAttribute('data-tone')).toBe('error');

    await harness.click(harness.chip());
    await harness.click(harness.menuItem('Reconnect'));
    expect(harness.session.calls).toEqual(['reconnect']);

    await harness.click(harness.chip());
    await harness.click(harness.menuItem('Runtime setup…'));
    expect(harness.runtimeRequests).toBe(1);

    harness.destroy();
  });

  it('becomes the runtime call to action, with run controls disabled, when there is no kernel', async () => {
    const harness = mount({ session: null });

    expect(harness.chip().textContent).toContain('No kernel — set up runtime');
    expect(harness.chip().getAttribute('data-tone')).toBe('error');
    expect(harness.button('Run').disabled).toBe(true);
    expect(harness.button('Restart').disabled).toBe(true);
    // Editing a notebook still works without a runtime.
    expect(harness.button('Insert code cell below').disabled).toBe(false);

    // There is no kernel to pick, so the chip is the call to action itself.
    expect(harness.chip().getAttribute('aria-haspopup')).toBeNull();
    await harness.click(harness.chip());
    expect(harness.runtimeRequests).toBe(1);
    expect(harness.container.querySelector('[role="menu"]')).toBeNull();

    harness.destroy();
  });
});

describe('NotebookToolbar notebook actions', () => {
  it('inserts a typed cell below the active cell', async () => {
    const harness = mount();
    harness.notebook.activeCellIndex = 0;

    await harness.click(harness.button('Insert code cell below'));
    expect(harness.notebook.widgets.length).toBe(3);
    expect(harness.notebook.widgets[1].model.type).toBe('code');

    await harness.click(harness.button('Insert markdown cell below'));
    expect(harness.notebook.widgets.length).toBe(4);
    expect(harness.notebook.widgets[2].model.type).toBe('markdown');

    harness.destroy();
  });

  it('keeps clear-all behind a confirmation in the overflow menu', async () => {
    const harness = mount();
    const outputs = () => (harness.notebook.widgets[0].model as unknown as {
      outputs: { length: number };
    }).outputs.length;

    await harness.openMenu('More notebook actions');
    expect(harness.menuItems().map((item) => item.textContent?.replace(/(⇧Z|Z)$/, ''))).toEqual([
      'Clear all outputs',
      'Collapse all outputs',
      'Expand all outputs',
      'Undo cell operation',
      'Redo cell operation',
    ]);

    await harness.click(harness.menuItem('Clear all outputs'));
    expect(outputs()).toBe(1);
    expect(harness.confirms[0].message).toBe('Clear every saved cell output?');
    await harness.acceptConfirm();
    expect(outputs()).toBe(0);

    harness.destroy();
  });

  // Asserted at the wiring level on purpose: the shared model's undo stack here
  // still holds the initial `fromJSON` population, so a real undo empties the
  // document rather than reverting one insert. That is the model's behaviour,
  // not the toolbar's, and enshrining it would be asserting a defect.
  it('routes undo and redo of cell operations to NotebookActions', async () => {
    const harness = mount();
    const undo = vi.spyOn(NotebookActions, 'undo').mockImplementation(() => {});
    const redo = vi.spyOn(NotebookActions, 'redo').mockImplementation(() => {});

    await harness.openMenu('More notebook actions');
    await harness.click(harness.menuItem('Undo cell operation'));
    expect(undo).toHaveBeenCalledWith(harness.notebook);

    await harness.openMenu('More notebook actions');
    await harness.click(harness.menuItem('Redo cell operation'));
    expect(redo).toHaveBeenCalledWith(harness.notebook);

    undo.mockRestore();
    redo.mockRestore();
    harness.destroy();
  });

  it('collapses and expands every output from the overflow menu', async () => {
    const harness = mount();
    const codeCell = harness.notebook.widgets[0] as unknown as { outputHidden: boolean };

    await harness.openMenu('More notebook actions');
    await harness.click(harness.menuItem('Collapse all outputs'));
    expect(codeCell.outputHidden).toBe(true);

    await harness.openMenu('More notebook actions');
    await harness.click(harness.menuItem('Expand all outputs'));
    expect(codeCell.outputHidden).toBe(false);

    harness.destroy();
  });

  it('disables every mutating control when the host is read-only', async () => {
    const harness = mount({ readOnly: true });

    expect(harness.button('Run').disabled).toBe(true);
    expect(harness.button('Restart').disabled).toBe(true);
    expect(harness.button('Insert code cell below').disabled).toBe(true);
    expect(harness.button('Insert markdown cell below').disabled).toBe(true);

    await harness.openMenu('More notebook actions');
    for (const item of harness.menuItems()) {
      expect(item.disabled).toBe(true);
    }

    harness.destroy();
  });
});

/**
 * The status dot is the only thing carrying kernel state once the chip label is
 * truncated, so it is a meaningful graphic and owes 3:1 against the surface it
 * sits on (WCAG 1.4.11). jsdom does not substitute `var()`, so this reads the
 * shipped values out of the stylesheet and does the arithmetic here -- which is
 * also what makes it a regression test rather than a snapshot.
 */
describe('NotebookToolbar status dots', () => {
  /** sRGB relative luminance, per WCAG. */
  function luminance([r, g, b]: number[]): number {
    const channel = (value: number) => {
      const c = value / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrast(a: number[], b: number[]): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
  }

  function parseHex(hex: string): number[] {
    return [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
  }

  const toolbarCss = () => readFileSync(resolve(process.cwd(), 'src/components/NotebookToolbar.css'), 'utf8');

  it('clears 3:1 against the light theme chip surface', () => {
    const css = toolbarCss();

    // The chip's own fallback wash, composited over the light theme's white
    // page -- the surface the dot actually sits on when the host supplies no
    // `--nim-bg-hover`. Read from the chip's own rule, not the first wash in
    // the file: the toolbar buttons use a different alpha. The fallback is the
    // darker of the two candidates (the host's own light value composites to a
    // lighter grey), so this is the conservative bound for a dark dot.
    const chipBlock = /\n\.jupyter-toolbar__chip \{([^}]*)\}/.exec(css);
    expect(chipBlock).not.toBeNull();
    const wash = /--nim-bg-hover, rgba\((\d+), (\d+), (\d+), ([\d.]+)\)\)/.exec(chipBlock![1]);
    expect(wash).not.toBeNull();
    const alpha = Number(wash![4]);
    const surface = [1, 2, 3].map((index) => alpha * Number(wash![index]) + (1 - alpha) * 255);

    const lightBlock = /\[data-jp-theme-light='true'\] \.jupyter-toolbar \{([^}]*)\}/.exec(css);
    expect(lightBlock).not.toBeNull();
    const dots = [...lightBlock![1].matchAll(/--jupyter-dot-([a-z]+): (#[0-9a-f]{6})/g)];
    // idle, busy, starting, error: every state the dot can report.
    expect(dots.map(([, name]) => name)).toEqual(['idle', 'busy', 'starting', 'error']);

    // Reported as a list so a failure names the dot and its measured ratio.
    const failing = dots
      .map(([, name, hex]) => ({ name, ratio: Number(contrast(parseHex(hex), surface).toFixed(2)) }))
      .filter((dot) => dot.ratio < 3);
    expect(failing).toEqual([]);
  });
});

describe('NotebookToolbar error reporting', () => {
  it('routes a failed action to onError instead of throwing', async () => {
    const harness = mount();
    harness.session.restart = () => Promise.reject(new Error('kernel gone'));

    await harness.click(harness.button('Restart'));
    await harness.acceptConfirm();

    expect(harness.errors).toEqual(['Restart kernel failed: kernel gone']);

    harness.destroy();
  });
});

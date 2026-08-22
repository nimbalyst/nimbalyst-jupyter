// @vitest-environment jsdom

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Signal } from '@lumino/signaling';
import type { SessionContext } from '@jupyterlab/apputils';
import type { Cell } from '@jupyterlab/cells';
import type { Notebook } from '@jupyterlab/notebook';
import type { KernelMessage } from '@jupyterlab/services';

type SessionContextModule = typeof import('../src/services/sessionContext');

let SessionContextManager: SessionContextModule['SessionContextManager'];
let deriveKernelChipViewModel: SessionContextModule['deriveKernelChipViewModel'];

const notebookActionSender = {};
const executed = new Signal<object, { notebook: Notebook; cell: Cell; success: boolean }>(
  notebookActionSender,
);
const notebookActions = {
  run: vi.fn(async () => true),
  runAndAdvance: vi.fn(async () => true),
  runAll: vi.fn(async () => true),
  runAllAbove: vi.fn(async () => true),
  runAllBelow: vi.fn(async () => true),
  clearAllOutputs: vi.fn(),
  executed,
};

beforeAll(async () => {
  vi.stubGlobal('DragEvent', class DragEvent extends Event {});
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
  vi.doMock('@jupyterlab/notebook', () => ({ NotebookActions: notebookActions }));
  ({ SessionContextManager, deriveKernelChipViewModel } = await import('../src/services/sessionContext'));
});

beforeEach(() => {
  vi.clearAllMocks();
  notebookActions.run.mockResolvedValue(true);
  notebookActions.runAndAdvance.mockResolvedValue(true);
  notebookActions.runAll.mockResolvedValue(true);
  notebookActions.runAllAbove.mockResolvedValue(true);
  notebookActions.runAllBelow.mockResolvedValue(true);
});

describe('SessionContextManager kernel lifecycle', () => {
  it('lists, switches, reconnects, interrupts, shuts down, and forwards status', async () => {
    const fixture = createContextFixture();
    const manager = createManager(fixture.context);
    const observed: string[] = [];
    manager.statusChanged.connect((_manager, status) => observed.push(status));

    await expect(manager.listKernels()).resolves.toEqual([
      { name: 'python3', displayName: 'Python 3', language: 'python' },
      { name: 'julia-1.10', displayName: 'Julia 1.10', language: 'julia' },
    ]);
    await expect(manager.changeKernel('julia-1.10')).resolves.toBe(true);
    await manager.reconnect();
    await manager.interrupt();
    fixture.statusChanged.emit('busy');

    expect(fixture.changeKernel).toHaveBeenCalledWith({ name: 'julia-1.10' });
    expect(fixture.reconnect).toHaveBeenCalledOnce();
    expect(fixture.interrupt).toHaveBeenCalledOnce();
    expect(observed).toEqual(['busy']);

    await manager.shutdown();
    expect(fixture.shutdown).toHaveBeenCalledOnce();
    manager.dispose();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it('caches kernel specs until an explicit refresh', async () => {
    const fixture = createContextFixture();
    const manager = createManager(fixture.context);

    const firstRequest = manager.listKernels();
    const secondRequest = manager.listKernels();
    expect(secondRequest).toBe(firstRequest);
    await firstRequest;
    expect(fixture.refreshSpecs).not.toHaveBeenCalled();

    fixture.refreshSpecs.mockImplementationOnce(async () => {
      fixture.specsManager.specs.kernelspecs.r = {
        display_name: 'R',
        language: 'R',
      };
    });
    await expect(manager.refreshKernels()).resolves.toContainEqual({
      name: 'r',
      displayName: 'R',
      language: 'R',
    });
    expect(fixture.refreshSpecs).toHaveBeenCalledOnce();
    await manager.listKernels();
    expect(fixture.refreshSpecs).toHaveBeenCalledOnce();

    manager.dispose();
  });

  it('reports per-code-cell progress for run all, above, and below', async () => {
    const fixture = createContextFixture();
    const manager = createManager(fixture.context);
    const cells = [createCell('code'), createCell('markdown'), createCell('code')];
    const notebook = {
      widgets: cells,
      activeCellIndex: 2,
      deselectAll: vi.fn(),
    } as unknown as Notebook;
    const observed: Array<{ current: number; total: number } | null> = [];
    manager.runProgressChanged.connect((_manager, progress) => observed.push(progress));

    notebookActions.runAll.mockImplementationOnce(async () => {
      expect(manager.kernelChipViewModel.label).toBe('Running cell 1 of 2');
      executed.emit({ notebook, cell: cells[0], success: true });
      expect(manager.kernelChipViewModel.label).toBe('Running cell 2 of 2');
      executed.emit({ notebook, cell: cells[2], success: true });
      return true;
    });
    await expect(manager.runAll(notebook)).resolves.toBe(true);
    expect(observed).toEqual([
      { current: 1, total: 2 },
      { current: 2, total: 2 },
      null,
    ]);

    observed.length = 0;
    notebookActions.runAllAbove.mockImplementationOnce(async () => {
      executed.emit({ notebook, cell: cells[0], success: true });
      return true;
    });
    await manager.runAbove(notebook);
    expect(observed).toEqual([{ current: 1, total: 1 }, null]);

    notebook.activeCellIndex = 1;
    observed.length = 0;
    notebookActions.runAllBelow.mockImplementationOnce(async () => {
      executed.emit({ notebook, cell: cells[2], success: true });
      return true;
    });
    await manager.runBelow(notebook);
    expect(observed).toEqual([{ current: 1, total: 1 }, null]);

    manager.dispose();
  });

  it('runs the requested cell instead of the current selection', async () => {
    const fixture = createContextFixture();
    const manager = createManager(fixture.context);
    const notebook = {
      widgets: [createCell('code'), createCell('code')],
      activeCellIndex: 0,
      deselectAll: vi.fn(),
    } as unknown as Notebook;

    await expect(manager.runCell(notebook, 1)).resolves.toBe(true);
    expect(notebook.activeCellIndex).toBe(1);
    expect(notebook.deselectAll).toHaveBeenCalledOnce();
    expect(notebookActions.run).toHaveBeenCalledWith(notebook, fixture.context);
    await expect(manager.runCell(notebook, 99)).resolves.toBe(false);
    expect(notebookActions.run).toHaveBeenCalledOnce();

    manager.dispose();
  });

  it('derives a complete chip model for connected and edit-only states', () => {
    const fixture = createContextFixture();
    const manager = createManager(fixture.context);

    expect(manager.kernelChipViewModel).toEqual({
      status: 'idle',
      label: 'Idle',
      kernelDisplayName: 'Python 3',
      runControlsEnabled: true,
    });
    expect(deriveKernelChipViewModel('no-kernel', null)).toEqual({
      status: 'no-kernel',
      label: 'No kernel',
      kernelDisplayName: null,
      runControlsEnabled: false,
    });

    manager.dispose();
  });
});

function createManager(context: SessionContext) {
  return new SessionContextManager({
    serviceManager: {} as never,
    path: 'analysis.ipynb',
    sessionContext: context,
  });
}

function createCell(type: 'code' | 'markdown'): Cell {
  return { model: { type } } as unknown as Cell;
}

function createContextFixture() {
  const sender = {};
  const statusChanged = new Signal<object, KernelMessage.Status>(sender);
  const kernelChanged = new Signal<object, never>(sender);
  const interrupt = vi.fn(async () => undefined);
  const reconnect = vi.fn(async () => undefined);
  const changeKernel = vi.fn(async () => ({ name: 'julia-1.10' }));
  const dispose = vi.fn();
  const shutdown = vi.fn(async () => undefined);
  const refreshSpecs = vi.fn(async () => undefined);
  const specsManager = {
    ready: Promise.resolve(),
    specs: {
      default: 'python3',
      kernelspecs: {
        python3: { display_name: 'Python 3', language: 'python' },
        'julia-1.10': { display_name: 'Julia 1.10', language: 'julia' },
      } as Record<string, { display_name: string; language: string }>,
    },
    refreshSpecs,
  };
  const context = {
    statusChanged,
    kernelChanged,
    session: { kernel: { name: 'python3', status: 'idle', interrupt, reconnect } },
    specsManager,
    kernelDisplayName: 'Python 3',
    initialize: vi.fn(async () => false),
    changeKernel,
    restartKernel: vi.fn(async () => ({ name: 'python3' })),
    shutdown,
    dispose,
  } as unknown as SessionContext;
  return {
    context,
    statusChanged,
    interrupt,
    reconnect,
    changeKernel,
    dispose,
    shutdown,
    refreshSpecs,
    specsManager,
  };
}

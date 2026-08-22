// @vitest-environment jsdom

/** Scratch: does `sharedModel.getId()` throw once the cell model is disposed? */

import { beforeAll, describe, expect, it, vi } from 'vitest';

let buildNotebook: typeof import('../src/services/buildNotebook').buildNotebook;

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
  vi.stubGlobal('cancelIdleCallback', () => {});
  vi.stubGlobal('DragEvent', class DragEvent extends Event {});
  vi.stubGlobal('ResizeObserver', class ResizeObserver {
    observe() {} unobserve() {} disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class IntersectionObserver {
    readonly root = null; readonly rootMargin = '0px'; readonly thresholds = [0];
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false, media: '', onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  });
  ({ buildNotebook } = await import('../src/services/buildNotebook'));
});

describe('disposed cell model', () => {
  it('reports what getId does after dispose', () => {
    const built = buildNotebook({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{ id: 'a', cell_type: 'code', metadata: {}, execution_count: null, source: 'x', outputs: [] }],
    }, { readOnly: false });

    const cell = built.notebook.widgets[0];
    const model = cell.model;
    let liveId: string | null = null;
    try {
      liveId = model.sharedModel.getId();
    } catch (error) {
      liveId = `THREW: ${(error as Error).message}`;
    }
    model.dispose();

    let disposedId: string;
    try {
      disposedId = model.sharedModel.getId();
    } catch (error) {
      disposedId = `THREW: ${(error as Error).message}`;
    }
    // eslint-disable-next-line no-console
    console.log('live:', liveId, '| after dispose:', disposedId, '| isDisposed:', model.isDisposed);

    // Same question for the whole doc being disposed, which is what a notebook
    // teardown does.
    built.dispose();
    let afterDocDispose: string;
    try {
      afterDocDispose = built.notebook.widgets[0]?.model.sharedModel.getId() ?? 'no widget';
    } catch (error) {
      afterDocDispose = `THREW: ${(error as Error).message}`;
    }
    // eslint-disable-next-line no-console
    console.log('after notebook dispose:', afterDocDispose);

    expect(true).toBe(true);
    for (const id of pendingIdleCallbacks) clearTimeout(id);
    pendingIdleCallbacks.clear();
  });
});

// @vitest-environment jsdom

/**
 * The confirmation gate is in-DOM precisely so it is assertable; these cover the
 * behavior E2E depends on. No testing-library here -- the repo has none, and
 * react-dom's own `act` is enough for a component this small.
 */

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { useConfirm, type RequestConfirm } from '../src/components/ConfirmDialog';

// React 18 refuses to run `act` without this opt-in flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  request: RequestConfirm;
  dialog: () => HTMLElement | null;
  backdrop: () => HTMLElement | null;
  button: (label: string) => HTMLButtonElement;
  destroy: () => void;
}

function mountHarness(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let request!: RequestConfirm;

  function Host() {
    const { requestConfirm, confirmDialog } = useConfirm();
    request = requestConfirm;
    return confirmDialog;
  }

  act(() => {
    root.render(<Host />);
  });

  return {
    request: (...args) => act(() => request(...args)),
    dialog: () => container.querySelector<HTMLElement>('[data-testid="jupyter-confirm-dialog"]'),
    backdrop: () => container.querySelector<HTMLElement>('[data-testid="jupyter-confirm-backdrop"]'),
    button: (label) => {
      const match = [...container.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === label,
      );
      if (!match) throw new Error(`No button labeled "${label}"`);
      return match;
    },
    destroy: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useConfirm', () => {
  it('runs the action only after the user confirms', () => {
    const harness = mountHarness();
    let confirmed = 0;

    expect(harness.dialog()).toBeNull();

    harness.request({ message: 'Delete the cell?', confirmLabel: 'Delete', onConfirm: () => { confirmed += 1; } });

    expect(harness.dialog()).not.toBeNull();
    expect(harness.dialog()?.textContent).toContain('Delete the cell?');
    // The gate is what makes this safe: nothing has run yet.
    expect(confirmed).toBe(0);

    act(() => harness.button('Delete').click());

    expect(confirmed).toBe(1);
    expect(harness.dialog()).toBeNull();

    harness.destroy();
  });

  it('drops the action when the user cancels', () => {
    const harness = mountHarness();
    let confirmed = 0;

    harness.request({ message: 'Delete the cell?', onConfirm: () => { confirmed += 1; } });
    act(() => harness.button('Cancel').click());

    expect(confirmed).toBe(0);
    expect(harness.dialog()).toBeNull();

    harness.destroy();
  });

  it('cancels on Escape and on a backdrop click', () => {
    const harness = mountHarness();
    let confirmed = 0;

    harness.request({ message: 'Restart the kernel?', onConfirm: () => { confirmed += 1; } });
    act(() => {
      harness.dialog()?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(harness.dialog()).toBeNull();

    harness.request({ message: 'Restart the kernel?', onConfirm: () => { confirmed += 1; } });
    const backdrop = harness.backdrop();
    act(() => {
      backdrop?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(harness.dialog()).toBeNull();

    expect(confirmed).toBe(0);
    harness.destroy();
  });

  it('defaults the confirm label and focuses it, then restores focus on close', () => {
    const harness = mountHarness();
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    harness.request({ message: 'Clear every saved cell output?', onConfirm: () => {} });

    // No confirmLabel supplied, so the generic one shows.
    const confirmButton = harness.button('Confirm');
    expect(document.activeElement).toBe(confirmButton);

    act(() => harness.button('Cancel').click());

    // Focus goes back where it came from -- a `dd` shortcut must not strand the
    // user outside the cell they were in.
    expect(document.activeElement).toBe(opener);

    opener.remove();
    harness.destroy();
  });
});

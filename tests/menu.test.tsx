// @vitest-environment jsdom

/**
 * Keyboard operability is the whole reason this primitive exists rather than a
 * div with onClick, so that is what is covered here. No testing-library -- the
 * repo has none; react-dom's `act` is enough (same shape as confirmDialog.test).
 */

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import { Menu, SplitButton, type MenuCloseReason, type MenuItem } from '../src/components/Menu';

// React 18 refuses to run `act` without this opt-in flag.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Harness {
  items: () => HTMLButtonElement[];
  focused: () => string | null;
  press: (key: string) => void;
  closes: MenuCloseReason[];
  trigger: HTMLButtonElement;
  surface: () => HTMLElement | null;
  destroy: () => void;
}

function mountMenu(items: MenuItem[]): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const trigger = document.createElement('button');
  document.body.appendChild(trigger);
  trigger.focus();

  const closes: MenuCloseReason[] = [];
  const root = createRoot(container);

  act(() => {
    root.render(
      <Menu
        open
        anchorEl={trigger}
        items={items}
        onClose={(reason) => closes.push(reason)}
        label="Test menu"
        data-testid="menu"
      />,
    );
  });

  const surface = () => container.querySelector<HTMLElement>('[data-testid="menu"]');

  return {
    items: () => [...container.querySelectorAll<HTMLButtonElement>('.jupyter-menu__item')],
    focused: () => (document.activeElement as HTMLElement | null)?.textContent ?? null,
    press: (key) => {
      act(() => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
    },
    closes,
    trigger,
    surface,
    destroy: () => {
      act(() => root.unmount());
      container.remove();
      trigger.remove();
    },
  };
}

const NAV_ITEMS: MenuItem[] = [
  { kind: 'header', label: 'Kernel' },
  { label: 'First', onSelect: () => {} },
  { label: 'Blocked', disabled: true, onSelect: () => {} },
  { kind: 'separator' },
  { label: 'Second', onSelect: () => {} },
  { label: 'Third', onSelect: () => {} },
];

describe('Menu keyboard navigation', () => {
  it('moves with arrows, wraps, and steps over disabled rows and non-items', () => {
    const harness = mountMenu(NAV_ITEMS);

    // Opens focused on the first enabled row -- not the header.
    expect(harness.focused()).toBe('First');

    // "Blocked" is disabled and the separator is not an item: both are skipped.
    harness.press('ArrowDown');
    expect(harness.focused()).toBe('Second');

    harness.press('ArrowDown');
    expect(harness.focused()).toBe('Third');

    // Wraps forward past the end...
    harness.press('ArrowDown');
    expect(harness.focused()).toBe('First');

    // ...and backward past the start, again skipping the disabled row.
    harness.press('ArrowUp');
    expect(harness.focused()).toBe('Third');

    harness.press('ArrowUp');
    expect(harness.focused()).toBe('Second');

    harness.press('ArrowUp');
    expect(harness.focused()).toBe('First');

    harness.destroy();
  });

  it('jumps to the first and last enabled rows on Home and End', () => {
    const harness = mountMenu([
      { label: 'Off the top', disabled: true, onSelect: () => {} },
      { label: 'Top', onSelect: () => {} },
      { label: 'Middle', onSelect: () => {} },
      { label: 'Bottom', onSelect: () => {} },
      { label: 'Off the bottom', disabled: true, onSelect: () => {} },
    ]);

    // A disabled row at either end is not a jump target.
    expect(harness.focused()).toBe('Top');

    harness.press('End');
    expect(harness.focused()).toBe('Bottom');

    harness.press('Home');
    expect(harness.focused()).toBe('Top');

    harness.destroy();
  });

  it('never lands on a disabled row anywhere in the cycle', () => {
    const harness = mountMenu(NAV_ITEMS);
    const blocked = harness.items().find((item) => item.textContent === 'Blocked');

    // The native `disabled` attribute is what keeps pointer and Tab off it too.
    expect(blocked?.disabled).toBe(true);
    expect(blocked?.tabIndex).toBe(-1);

    const visited: (string | null)[] = [harness.focused()];
    for (let i = 0; i < 8; i += 1) {
      harness.press('ArrowDown');
      visited.push(harness.focused());
    }
    for (let i = 0; i < 8; i += 1) {
      harness.press('ArrowUp');
      visited.push(harness.focused());
    }

    expect(visited).not.toContain('Blocked');
    expect(new Set(visited)).toEqual(new Set(['First', 'Second', 'Third']));

    harness.destroy();
  });

  it('activates the focused row on Enter and on Space, then closes', () => {
    const chosen: string[] = [];
    const items: MenuItem[] = [
      { label: 'Run all', onSelect: () => chosen.push('Run all') },
      { label: 'Run above', onSelect: () => chosen.push('Run above') },
    ];

    const enter = mountMenu(items);
    enter.press('ArrowDown');
    enter.press('Enter');
    expect(chosen).toEqual(['Run above']);
    expect(enter.closes).toEqual(['select']);
    // Focus is handed back so the next keystroke still reaches the toolbar.
    expect(document.activeElement).toBe(enter.trigger);
    enter.destroy();

    const space = mountMenu(items);
    space.press(' ');
    expect(chosen).toEqual(['Run above', 'Run all']);
    expect(space.closes).toEqual(['select']);
    space.destroy();
  });

  it('closes on Escape and on Tab, returning focus to the trigger both times', () => {
    const escape = mountMenu(NAV_ITEMS);
    escape.press('Escape');
    expect(escape.closes).toEqual(['escape']);
    expect(document.activeElement).toBe(escape.trigger);
    escape.destroy();

    // Tab hands focus back first and does not preventDefault, so the browser's
    // own Tab continues from the trigger rather than from a removed node.
    const tab = mountMenu(NAV_ITEMS);
    tab.press('Tab');
    expect(tab.closes).toEqual(['tab']);
    expect(document.activeElement).toBe(tab.trigger);
    tab.destroy();
  });

  it('opens on the checked row when there is one', () => {
    const harness = mountMenu([
      { kind: 'header', label: 'Kernel' },
      { label: 'Python 3', checked: false, onSelect: () => {} },
      { label: 'Deno', checked: true, onSelect: () => {} },
    ]);

    expect(harness.focused()).toBe('Deno');

    harness.destroy();
  });
});

describe('Menu dismissal', () => {
  it('dismisses on an outside mousedown but not on one inside the menu or the trigger', () => {
    const harness = mountMenu(NAV_ITEMS);

    act(() => {
      harness.items()[0]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(harness.closes).toEqual([]);

    // The trigger's own click already toggles; closing here would fight it.
    act(() => {
      harness.trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(harness.closes).toEqual([]);

    act(() => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(harness.closes).toEqual(['outside']);

    harness.destroy();
  });

  /**
   * The menu is positioned once, so a scroll that moves its anchor has to
   * dismiss it. A scroll that cannot move the anchor must not: this runs
   * inside Nimbalyst, where a streaming AI transcript scrolls continuously in
   * another pane, and a capture listener on `window` sees every one of those.
   * Closing on them made the eight actions behind a cell's `···` unusable
   * while an agent was writing.
   */
  it('dismisses on a scroll that moves the anchor, and ignores every other one', () => {
    const scrolled = mountMenu(NAV_ITEMS);
    const elsewhere = document.createElement('div');
    document.body.appendChild(elsewhere);

    act(() => {
      elsewhere.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(scrolled.closes).toEqual([]);

    // The menu's own surface scrolls when its rows overflow; that is not the
    // anchor moving either.
    act(() => {
      scrolled.surface()?.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(scrolled.closes).toEqual([]);

    // An ancestor of the trigger is the case that does move it.
    act(() => {
      document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(scrolled.closes).toEqual(['scroll']);
    elsewhere.remove();
    scrolled.destroy();

    const resized = mountMenu(NAV_ITEMS);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(resized.closes).toEqual(['resize']);
    resized.destroy();
  });
});

describe('Menu accessibility', () => {
  it('exposes menu/menuitem roles, a separator, and radio state for checkable rows', () => {
    const harness = mountMenu([
      { kind: 'header', label: 'Kernel' },
      { label: 'Python 3', checked: true, onSelect: () => {} },
      { kind: 'separator' },
      { label: 'Reconnect', onSelect: () => {} },
      { label: 'Shut down', danger: true, onSelect: () => {} },
    ]);

    const surface = harness.surface();
    expect(surface?.getAttribute('role')).toBe('menu');
    expect(surface?.getAttribute('aria-label')).toBe('Test menu');

    const roles = harness.items().map((item) => item.getAttribute('role'));
    expect(roles).toEqual(['menuitemradio', 'menuitem', 'menuitem']);

    const python = harness.items()[0];
    expect(python.getAttribute('aria-checked')).toBe('true');
    // A plain item must not claim a checked state it does not have.
    expect(harness.items()[1].getAttribute('aria-checked')).toBeNull();

    expect(surface?.querySelectorAll('[role="separator"]').length).toBe(1);
    // The header is a label, not a stop on the keyboard path.
    expect(surface?.querySelector('.jupyter-menu__header')?.textContent).toBe('Kernel');

    expect(harness.items()[2].getAttribute('data-danger')).toBe('true');

    harness.destroy();
  });

  it('renders the leading icon and the trailing shortcut hint', () => {
    const harness = mountMenu([
      { label: 'Run cell and advance', shortcut: '⇧⏎', onSelect: () => {} },
    ]);

    const item = harness.items()[0];
    expect(item.querySelector('.jupyter-menu__shortcut')?.textContent).toBe('⇧⏎');

    harness.destroy();
  });
});

describe('SplitButton', () => {
  function mountSplit() {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const events: string[] = [];

    act(() => {
      root.render(
        <SplitButton
          label="Run"
          tone="primary"
          menuLabel="Run options"
          onClick={() => events.push('run')}
          items={[
            { label: 'Run all cells', onSelect: () => events.push('run all') },
            { label: 'Run all above', disabled: true, onSelect: () => events.push('run above') },
          ]}
        />,
      );
    });

    return {
      events,
      main: () => container.querySelector<HTMLButtonElement>('.jupyter-split__main')!,
      caret: () => container.querySelector<HTMLButtonElement>('.jupyter-split__caret')!,
      menu: () => container.querySelector<HTMLElement>('[role="menu"]'),
      destroy: () => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  it('runs the primary action, and opens its menu from the caret with the ARIA pair wired', () => {
    const split = mountSplit();

    expect(split.caret().getAttribute('aria-haspopup')).toBe('menu');
    expect(split.caret().getAttribute('aria-expanded')).toBe('false');
    expect(split.menu()).toBeNull();

    act(() => split.main().click());
    expect(split.events).toEqual(['run']);
    expect(split.menu()).toBeNull();

    act(() => split.caret().click());
    expect(split.caret().getAttribute('aria-expanded')).toBe('true');
    expect(split.menu()).not.toBeNull();

    // Opened by pointer, but still keyboard-driven from the first enabled row.
    act(() => {
      (document.activeElement ?? document.body).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    });
    expect(split.events).toEqual(['run', 'run all']);
    expect(split.menu()).toBeNull();
    expect(document.activeElement).toBe(split.caret());

    split.destroy();
  });
});

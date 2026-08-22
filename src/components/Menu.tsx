/**
 * Anchored menu/popover primitive for the notebook toolbars.
 *
 * The extension has no menu component of its own and no access to the host's,
 * so this is a deliberately small, dependency-free one: a `position: fixed`
 * surface (fixed so a narrow, `overflow: auto` toolbar cannot clip it) whose
 * coordinates are measured from the trigger on open, flipped and then clamped
 * to stay inside the viewport.
 *
 * It is positioned once per open. A resize, or a scroll of something that
 * actually contains the anchor, dismisses it rather than re-positioning it --
 * that is what every native menu does, and it keeps this file free of a reflow
 * loop. Scrolls elsewhere in the renderer are ignored; see `onScroll`.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from 'react';

import './Menu.css';

/** Why a menu closed. Consumers use it to decide whether to re-focus something. */
export type MenuCloseReason = 'select' | 'escape' | 'tab' | 'outside' | 'scroll' | 'resize';

/** A selectable row. `kind` may be omitted -- action is the default. */
export interface MenuActionItem {
  kind?: 'action';
  /** Optional stable key; the array index is used when absent. */
  id?: string;
  label: ReactNode;
  /** Leading glyph (status dot, icon svg). Sits in a fixed-width slot. */
  icon?: ReactNode;
  /** Trailing keyboard hint, e.g. `⇧⏎`. Rendered muted and monospaced. */
  shortcut?: string;
  disabled?: boolean;
  /** Destructive tone (red label). */
  danger?: boolean;
  /**
   * Selected state. Supplying it (even as `false`) switches the default role to
   * `menuitemradio` and reserves a leading check slot when there is no `icon`.
   */
  checked?: boolean;
  /** Overrides the role derived from `checked`. */
  role?: 'menuitem' | 'menuitemradio' | 'menuitemcheckbox';
  /** Native tooltip. */
  title?: string;
  onSelect: () => void;
}

/** Non-interactive uppercase section label, e.g. the kernel popover's "KERNEL". */
export interface MenuHeaderItem {
  kind: 'header';
  id?: string;
  label: string;
}

/** Horizontal rule between groups. */
export interface MenuSeparatorItem {
  kind: 'separator';
  id?: string;
}

export type MenuItem = MenuActionItem | MenuHeaderItem | MenuSeparatorItem;

export interface MenuProps {
  open: boolean;
  /** Element the surface is positioned against, and that focus returns to. */
  anchorEl: HTMLElement | null;
  items: MenuItem[];
  onClose: (reason: MenuCloseReason) => void;
  /** Which anchor edge the surface aligns to. Flips when it would overflow. Default `start`. */
  align?: 'start' | 'end';
  /** Preferred side of the anchor. Flips when it would overflow. Default `bottom`. */
  side?: 'bottom' | 'top';
  /** Gap between anchor and surface, in px. Default 4. */
  offset?: number;
  /** Minimum surface width, in px. Default 220. */
  minWidth?: number;
  /** Rectangle to stay inside. Defaults to the window viewport. */
  boundary?: HTMLElement | null;
  /** `aria-label` for the surface. */
  label?: string;
  /** DOM id for the surface, for the trigger's `aria-controls`. */
  id?: string;
  className?: string;
  /** Focus the first (or checked) item on open. Default true. */
  autoFocus?: boolean;
  'data-testid'?: string;
}

const BOUNDARY_MARGIN = 6;

interface Position {
  top: number;
  left: number;
  maxHeight: number;
}

function isActionItem(item: MenuItem): item is MenuActionItem {
  return item.kind === undefined || item.kind === 'action';
}

function isSelectable(item: MenuItem): boolean {
  return isActionItem(item) && !item.disabled;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function Menu({
  open,
  anchorEl,
  items,
  onClose,
  align = 'start',
  side = 'bottom',
  offset = 4,
  minWidth = 220,
  boundary,
  label,
  id,
  className,
  autoFocus = true,
  'data-testid': dataTestId,
}: MenuProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectableIndexes = useMemo(
    () => items.reduce<number[]>((acc, item, index) => {
      if (isSelectable(item)) acc.push(index);
      return acc;
    }, []),
    [items],
  );

  /** Close, handing focus back to the trigger when the menu still holds it. */
  const closeWith = useCallback(
    (reason: MenuCloseReason, restoreFocus: boolean) => {
      if (restoreFocus && anchorEl?.isConnected) anchorEl.focus();
      onClose(reason);
    },
    [anchorEl, onClose],
  );

  // Measure and place once per open. Rendered hidden until then so the
  // unpositioned surface never flashes at 0,0.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const surface = surfaceRef.current;
    if (!surface || !anchorEl) return;

    const anchor = anchorEl.getBoundingClientRect();
    const rect = surface.getBoundingClientRect();
    const bounds = boundary
      ? boundary.getBoundingClientRect()
      : { top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth };

    const below = anchor.bottom + offset;
    const above = anchor.top - rect.height - offset;
    let top = side === 'top' ? above : below;
    if (side === 'bottom' && below + rect.height > bounds.bottom - BOUNDARY_MARGIN && above >= bounds.top + BOUNDARY_MARGIN) {
      top = above;
    } else if (side === 'top' && above < bounds.top + BOUNDARY_MARGIN && below + rect.height <= bounds.bottom - BOUNDARY_MARGIN) {
      top = below;
    }
    top = clamp(top, bounds.top + BOUNDARY_MARGIN, bounds.bottom - BOUNDARY_MARGIN - rect.height);

    const atStart = anchor.left;
    const atEnd = anchor.right - rect.width;
    let left = align === 'end' ? atEnd : atStart;
    if (align === 'start' && atStart + rect.width > bounds.right - BOUNDARY_MARGIN) left = atEnd;
    else if (align === 'end' && atEnd < bounds.left + BOUNDARY_MARGIN) left = atStart;
    left = clamp(left, bounds.left + BOUNDARY_MARGIN, bounds.right - BOUNDARY_MARGIN - rect.width);

    setPosition({ top, left, maxHeight: Math.max(0, bounds.bottom - BOUNDARY_MARGIN - top) });
  }, [open, anchorEl, boundary, align, side, offset, items]);

  // Land focus on the checked row when there is one -- the kernel popover should
  // open on the kernel you are already using.
  useEffect(() => {
    if (!open) {
      setActiveIndex(-1);
      return;
    }
    const checked = selectableIndexes.find((index) => {
      const item = items[index];
      return isActionItem(item) && item.checked === true;
    });
    const initial = checked ?? selectableIndexes[0] ?? -1;
    setActiveIndex(initial);
    if (autoFocus) {
      if (initial >= 0) itemRefs.current[initial]?.focus();
      else surfaceRef.current?.focus();
    }
    // `items` is intentionally excluded: re-focusing on every item rebuild would
    // steal focus back from wherever the user has since arrowed to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, autoFocus]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (surfaceRef.current?.contains(target)) return;
      if (anchorEl?.contains(target)) return; // the trigger's own click toggles
      closeWith('outside', false);
    };
    /**
     * Capture-phase on `window` is the only way to hear a scroll from an
     * arbitrary ancestor, but it also hears every unrelated one in the
     * renderer -- a streaming AI transcript scrolls constantly. Only a
     * scroller that contains the anchor can have moved it.
     */
    const onScroll = (event: Event) => {
      const scroller = event.target as Node | null;
      if (anchorEl && scroller && typeof scroller.contains === 'function'
        && !scroller.contains(anchorEl)) return;
      closeWith('scroll', false);
    };
    const onResize = () => closeWith('resize', false);

    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, anchorEl, closeWith]);

  const moveTo = useCallback(
    (index: number) => {
      if (index < 0) return;
      setActiveIndex(index);
      itemRefs.current[index]?.focus();
    },
    [],
  );

  const step = useCallback(
    (delta: number) => {
      if (selectableIndexes.length === 0) return;
      const current = selectableIndexes.indexOf(activeIndex);
      const next = current === -1
        ? (delta > 0 ? 0 : selectableIndexes.length - 1)
        : (current + delta + selectableIndexes.length) % selectableIndexes.length;
      moveTo(selectableIndexes[next]);
    },
    [activeIndex, selectableIndexes, moveTo],
  );

  const select = useCallback(
    (index: number) => {
      const item = items[index];
      if (!item || !isActionItem(item) || item.disabled) return;
      closeWith('select', true);
      item.onSelect();
    },
    [items, closeWith],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        step(-1);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        moveTo(selectableIndexes[0] ?? -1);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        moveTo(selectableIndexes[selectableIndexes.length - 1] ?? -1);
        break;
      case 'Enter':
      case ' ':
      case 'Spacebar':
        // preventDefault also suppresses the button's synthesized click, so the
        // handler below is the single path that fires `onSelect`.
        event.preventDefault();
        event.stopPropagation();
        select(activeIndex);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        closeWith('escape', true);
        break;
      case 'Tab':
        // No preventDefault: focus is handed to the trigger first, so the
        // browser's own Tab then continues from there rather than nowhere.
        closeWith('tab', true);
        break;
      default:
        break;
    }
  };

  if (!open) return null;

  itemRefs.current.length = items.length;

  return (
    <div
      ref={surfaceRef}
      id={id}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      data-testid={dataTestId}
      className={['jupyter-menu', className].filter(Boolean).join(' ')}
      style={{
        position: 'fixed',
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        minWidth,
        maxHeight: position?.maxHeight,
        visibility: position ? 'visible' : 'hidden',
      }}
      onKeyDown={handleKeyDown}
    >
      {items.map((item, index) => {
        if (item.kind === 'separator') {
          return <div key={item.id ?? `sep-${index}`} className="jupyter-menu__rule" role="separator" />;
        }
        if (item.kind === 'header') {
          return (
            <div key={item.id ?? `head-${index}`} className="jupyter-menu__header" role="presentation">
              {item.label}
            </div>
          );
        }
        const role = item.role ?? (item.checked === undefined ? 'menuitem' : 'menuitemradio');
        const showCheckSlot = item.checked !== undefined && item.icon === undefined;
        return (
          <button
            key={item.id ?? `item-${index}`}
            type="button"
            role={role}
            title={item.title}
            className="jupyter-menu__item"
            data-menu-index={index}
            data-danger={item.danger ? 'true' : undefined}
            data-checked={item.checked ? 'true' : undefined}
            data-active={activeIndex === index ? 'true' : undefined}
            aria-checked={role === 'menuitem' ? undefined : item.checked === true}
            disabled={item.disabled}
            tabIndex={activeIndex === index ? 0 : -1}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            onClick={() => select(index)}
            onMouseEnter={() => setActiveIndex(index)}
          >
            {item.icon !== undefined && <span className="jupyter-menu__icon">{item.icon}</span>}
            {showCheckSlot && (
              <span className="jupyter-menu__icon" aria-hidden="true">
                {item.checked ? <CheckIcon /> : null}
              </span>
            )}
            <span className="jupyter-menu__label">{item.label}</span>
            {item.shortcut !== undefined && <span className="jupyter-menu__shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface UseMenuOptions {
  /** DOM id for the surface; also wired to the trigger's `aria-controls`. */
  id?: string;
  onOpenChange?: (open: boolean) => void;
}

export interface MenuTriggerProps<T extends HTMLElement> {
  ref: RefObject<T>;
  'aria-haspopup': 'menu';
  'aria-expanded': boolean;
  'aria-controls': string | undefined;
  onClick: () => void;
  onKeyDown: (event: ReactKeyboardEvent<T>) => void;
}

export interface UseMenuResult<T extends HTMLElement> {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  close: (reason?: MenuCloseReason) => void;
  triggerRef: RefObject<T>;
  /** Spread onto any trigger element. */
  triggerProps: MenuTriggerProps<T>;
  /** Spread onto `<Menu>`; supply `items` (and any layout props) yourself. */
  menuProps: Pick<MenuProps, 'open' | 'anchorEl' | 'onClose' | 'id'>;
}

/**
 * Wires a trigger to a `<Menu>`: open state, the ARIA pair, and ArrowDown-opens.
 */
export function useMenu<T extends HTMLElement = HTMLButtonElement>(
  options: UseMenuOptions = {},
): UseMenuResult<T> {
  const { id, onOpenChange } = options;
  const triggerRef = useRef<T>(null);
  const [open, setOpenState] = useState(false);

  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState((current) => {
        if (current !== next) onOpenChange?.(next);
        return next;
      });
    },
    [onOpenChange],
  );

  const toggle = useCallback(() => {
    setOpenState((current) => {
      onOpenChange?.(!current);
      return !current;
    });
  }, [onOpenChange]);

  const close = useCallback(() => setOpen(false), [setOpen]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<T>) => {
      if (event.key === 'ArrowDown' && !open) {
        event.preventDefault();
        setOpen(true);
      }
    },
    [open, setOpen],
  );

  return {
    open,
    setOpen,
    toggle,
    close,
    triggerRef,
    triggerProps: {
      ref: triggerRef,
      'aria-haspopup': 'menu',
      'aria-expanded': open,
      'aria-controls': open ? id : undefined,
      onClick: toggle,
      onKeyDown,
    },
    menuProps: {
      open,
      anchorEl: triggerRef.current,
      onClose: close,
      id,
    },
  };
}

export interface SplitButtonProps {
  /** Primary label, e.g. `Run`. */
  label: ReactNode;
  /** Leading glyph for the primary half. */
  icon?: ReactNode;
  /** Fired by the primary half. */
  onClick: () => void;
  /** Rows for the caret half's menu. */
  items: MenuItem[];
  /** Visual weight. `primary` is the tinted Run treatment. Default `default`. */
  tone?: 'default' | 'primary' | 'danger';
  /** Disables both halves. */
  disabled?: boolean;
  /** Disables only the primary half, leaving the menu reachable. */
  mainDisabled?: boolean;
  /** Disables only the caret half. */
  menuDisabled?: boolean;
  /**
   * Drops the caret half entirely, leaving a bare button. For a control whose
   * menu is meaningless in one state -- the toolbar's Stop, whose Run rows
   * would only queue more work on a kernel that is already busy. Pin the
   * container's width if the row must not reflow when this flips.
   */
  menuHidden?: boolean;
  /** Native tooltip for the primary half. */
  title?: string;
  /** `aria-label` for the primary half when `label` is not plain text. */
  ariaLabel?: string;
  /** Label for the caret half and its menu. Defaults to `More options`. */
  menuLabel?: string;
  /** Alignment of the menu against the control. Default `start`. */
  menuAlign?: 'start' | 'end';
  /** DOM id for the menu surface. */
  menuId?: string;
  className?: string;
  'data-testid'?: string;
}

/**
 * A primary action joined to a caret that opens its menu -- the toolbar's
 * `Run ▾` / `Restart ▾` control. Two buttons, one visual unit.
 */
export function SplitButton({
  label,
  icon,
  onClick,
  items,
  tone = 'default',
  disabled = false,
  mainDisabled = false,
  menuDisabled = false,
  menuHidden = false,
  title,
  ariaLabel,
  menuLabel = 'More options',
  menuAlign = 'start',
  menuId,
  className,
  'data-testid': dataTestId,
}: SplitButtonProps) {
  const menu = useMenu<HTMLButtonElement>({ id: menuId });

  return (
    <span
      className={['jupyter-split', className].filter(Boolean).join(' ')}
      data-tone={tone}
      data-testid={dataTestId}
    >
      <button
        type="button"
        className="jupyter-split__main"
        title={title}
        aria-label={ariaLabel}
        disabled={disabled || mainDisabled}
        onClick={onClick}
      >
        {icon !== undefined && <span className="jupyter-split__icon">{icon}</span>}
        {label}
      </button>
      {menuHidden ? null : (
        <>
          <button
            type="button"
            className="jupyter-split__caret"
            title={menuLabel}
            aria-label={menuLabel}
            disabled={disabled || menuDisabled}
            {...menu.triggerProps}
          >
            <CaretIcon />
          </button>
          <Menu {...menu.menuProps} items={items} align={menuAlign} label={menuLabel} />
        </>
      )}
    </span>
  );
}

function CaretIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <path d="M4 6.5 8 10.5l4-4" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5l6-7" />
    </svg>
  );
}

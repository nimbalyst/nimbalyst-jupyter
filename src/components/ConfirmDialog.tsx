/**
 * In-DOM replacement for `window.confirm`.
 *
 * Native dialogs block the renderer and are invisible to the DOM, so E2E has to
 * install a page-level `dialog` handler and can never assert on the prompt text
 * or on the Cancel path landing on the right action. This renders the same
 * gate as real markup inside the editor root, so tests drive it like any other
 * UI and destructive actions stay assertable.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import './ConfirmDialog.css';

export interface ConfirmRequest {
  /** Question shown to the user, e.g. `Delete the selected notebook cell(s)?` */
  message: string;
  /** Label for the confirming button. Defaults to `Confirm`. */
  confirmLabel?: string;
  /** Ran only when the user confirms. */
  onConfirm: () => void;
}

export type RequestConfirm = (request: ConfirmRequest) => void;

/**
 * Owns the pending confirmation. `requestConfirm` keeps a stable identity so
 * imperative callers registered once (key handlers, host menu items) can hold
 * onto it without re-registering.
 */
export function useConfirm(): { requestConfirm: RequestConfirm; confirmDialog: JSX.Element | null } {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);

  const requestConfirm = useCallback<RequestConfirm>((request) => {
    setPending(request);
  }, []);

  const resolve = useCallback((confirmed: boolean) => {
    setPending((current) => {
      if (confirmed) current?.onConfirm();
      return null;
    });
  }, []);

  return {
    requestConfirm,
    confirmDialog: pending ? <ConfirmDialog request={pending} onResolve={resolve} /> : null,
  };
}

interface ConfirmDialogProps {
  request: ConfirmRequest;
  onResolve: (confirmed: boolean) => void;
}

function ConfirmDialog({ request, onResolve }: ConfirmDialogProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  // Focus lives in the notebook widget when a shortcut opens this; hand it back
  // on close so the user keeps their place in the cell they were editing.
  const previouslyFocusedRef = useRef<Element | null>(null);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement;
    confirmButtonRef.current?.focus();
    return () => {
      const previous = previouslyFocusedRef.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onResolve(false);
    }
  };

  return (
    <div
      className="jupyter-confirm-backdrop"
      data-testid="jupyter-confirm-backdrop"
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onResolve(false);
      }}
    >
      <div
        className="jupyter-confirm"
        data-testid="jupyter-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label={request.message}
      >
        <p className="jupyter-confirm__message">{request.message}</p>
        <div className="jupyter-confirm__actions">
          <button type="button" className="jupyter-confirm__cancel" onClick={() => onResolve(false)}>
            Cancel
          </button>
          <button
            type="button"
            className="jupyter-confirm__confirm"
            ref={confirmButtonRef}
            onClick={() => onResolve(true)}
          >
            {request.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useId, useRef, useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useVisualViewport } from '@/shared/hooks/useVisualViewport';

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  maxWidthClassName?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  mobileSheet?: boolean;
}

const stopPointerPropagation = (event: ReactPointerEvent) => {
  event.stopPropagation();
};

const subscribeToHydration = () => () => {};

export function Dialog({
  open,
  onClose,
  title,
  description,
  maxWidthClassName = 'max-w-md',
  children,
  footer,
  mobileSheet = false,
}: DialogProps) {
  const viewport = useVisualViewport();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const isHydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);

  useEffect(() => {
    if (!isHydrated) return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }
    } else if (dialog.open) {
      dialog.close();
    }
  }, [isHydrated, open]);

  const dialogNode = (
    <dialog
      ref={dialogRef}
      style={viewport ? {
        '--dialog-viewport-height': `${viewport.height}px`,
        '--dialog-viewport-top': `${viewport.offsetTop}px`,
      } as CSSProperties : undefined}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={`dialog-surface ${mobileSheet ? 'dialog-sheet' : ''} fixed inset-0 m-auto w-[calc(100%-2rem)] ${maxWidthClassName} rounded-2xl border border-border bg-panel p-0 shadow-2xl backdrop:bg-ink/60 backdrop:backdrop-blur-sm`}
      onClose={onClose}
      onPointerDown={stopPointerPropagation}
      onPointerMove={stopPointerPropagation}
      onPointerUp={stopPointerPropagation}
    >
      <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border p-5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-lg font-semibold">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="mt-1 text-sm text-muted">
              {description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          aria-label="Close dialog"
          onClick={onClose}
          className="rounded-lg p-1.5 text-muted transition-colors hover:bg-border/30 hover:text-ink"
        >
          <svg className="size-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="dialog-body p-5">{children}</div>
      {footer ? <div className="dialog-footer">{footer}</div> : null}
    </dialog>
  );

  if (!isHydrated || typeof document === 'undefined') {
    return null;
  }

  return createPortal(dialogNode, document.body);
}

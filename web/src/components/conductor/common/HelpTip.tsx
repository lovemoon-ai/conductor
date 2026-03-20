'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

interface HelpTipProps {
  label: string;
  children: React.ReactNode;
  align?: 'left' | 'right';
}

export function HelpTip({ label, children, align = 'left' }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const popupRef = useRef<HTMLSpanElement>(null);
  const contentId = useId();
  const [popupStyle, setPopupStyle] = useState<CSSProperties>();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !containerRef.current?.contains(target)
        && !popupRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      return;
    }

    const anchor = containerRef.current;
    if (!anchor) {
      return;
    }

    const nearestDialog = anchor.closest('dialog');
    setPortalTarget(nearestDialog instanceof HTMLElement ? nearestDialog : document.body);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || typeof window === 'undefined') {
      return;
    }

    const updatePosition = () => {
      const anchor = containerRef.current;
      const popup = popupRef.current;
      if (!anchor || !popup) {
        return;
      }

      const margin = 12;
      const gap = 8;
      const anchorRect = anchor.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      let left = align === 'right'
        ? anchorRect.right - popupRect.width
        : anchorRect.left;
      left = Math.min(
        Math.max(left, margin),
        Math.max(margin, viewportWidth - popupRect.width - margin),
      );

      const preferredBottomTop = anchorRect.bottom + gap;
      const canOpenAbove = anchorRect.top - gap - popupRect.height >= margin;
      const shouldOpenAbove = preferredBottomTop + popupRect.height > viewportHeight - margin && canOpenAbove;
      let top = shouldOpenAbove
        ? anchorRect.top - popupRect.height - gap
        : preferredBottomTop;
      top = Math.min(
        Math.max(top, margin),
        Math.max(margin, viewportHeight - popupRect.height - margin),
      );

      setPopupStyle({
        position: 'fixed',
        left,
        top,
        zIndex: 9999,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [align, open, portalTarget]);

  return (
    <span ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={`Show help for ${label}`}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((prev) => !prev)}
        className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border bg-paper text-[11px] font-semibold text-muted transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
      >
        ?
      </button>
      {open && portalTarget
        ? createPortal(
          <span
            ref={popupRef}
            id={contentId}
            role="dialog"
            style={popupStyle}
            className="z-[9999] w-64 rounded-xl border border-border bg-[var(--surface-panel)] p-3 text-xs leading-5 text-muted shadow-[0_18px_48px_rgba(0,0,0,0.18)]"
          >
            {children}
          </span>,
          portalTarget,
        )
        : null}
    </span>
  );
}

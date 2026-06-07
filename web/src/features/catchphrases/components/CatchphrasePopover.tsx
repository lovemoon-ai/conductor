'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useCatchphrasesStore, type Catchphrase } from '../store';

const SINGLE_CLICK_DELAY_MS = 180;

interface CatchphrasePopoverProps {
  /** Whether the popover is currently visible. Owner of the boolean is the parent. */
  open: boolean;
  /** Called when the popover should close — outside click, Escape, etc. */
  onClose: () => void;
  /** Single-click action: fill the chat textarea with the catchphrase's text. */
  onPick: (catchphrase: Catchphrase) => void;
  /** Double-click action: submit the catchphrase as a chat message immediately. */
  onSend: (catchphrase: Catchphrase) => void;
}

/**
 * Catchphrase quick-pick overlay rendered above the chat composer when the
 * user double-clicks an empty textarea (RFC 0032 §5).
 *
 * Interaction:
 *   • single-click row → `onPick` (fills the input, popover closes)
 *   • double-click row → `onSend` (submits immediately, popover closes)
 *   • ArrowUp / ArrowDown / Enter / Shift+Enter for keyboard-only flow
 *   • click outside or Escape → close
 */
export function CatchphrasePopover({ open, onClose, onPick, onSend }: CatchphrasePopoverProps) {
  const { catchphrases, hydrated, loading, error, hydrate, touch } = useCatchphrasesStore();
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const singleClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Lazy hydrate the first time the popover opens, so users who never use
  // catchphrases pay zero network cost.
  useEffect(() => {
    if (open && !hydrated) {
      void hydrate();
    }
  }, [open, hydrated, hydrate]);

  useEffect(() => {
    if (!open) {
      if (singleClickTimerRef.current) {
        clearTimeout(singleClickTimerRef.current);
        singleClickTimerRef.current = null;
      }
      return;
    }
    setHighlightIndex(0);
    // Programmatically focus the container so ArrowUp/Down/Enter/Shift+Enter
    // are received by `handleListKeyDown`. Without this, focus stays on the
    // textarea and the keyboard hint shown to the user would be a lie.
    requestAnimationFrame(() => {
      containerRef.current?.focus({ preventScroll: true });
    });
  }, [open]);

  useEffect(() => () => {
    if (singleClickTimerRef.current) {
      clearTimeout(singleClickTimerRef.current);
    }
  }, []);

  // Outside-click + Escape handlers.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && containerRef.current && !containerRef.current.contains(target)) {
        onClose();
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  const handlePick = (catchphrase: Catchphrase) => {
    void touch(catchphrase.id);
    onPick(catchphrase);
  };

  const schedulePick = (catchphrase: Catchphrase) => {
    if (singleClickTimerRef.current) {
      clearTimeout(singleClickTimerRef.current);
    }
    singleClickTimerRef.current = setTimeout(() => {
      singleClickTimerRef.current = null;
      handlePick(catchphrase);
    }, SINGLE_CLICK_DELAY_MS);
  };

  const handleSend = (catchphrase: Catchphrase) => {
    if (singleClickTimerRef.current) {
      clearTimeout(singleClickTimerRef.current);
      singleClickTimerRef.current = null;
    }
    void touch(catchphrase.id);
    onSend(catchphrase);
  };

  const handleListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (catchphrases.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIndex((current) => (current + 1) % catchphrases.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIndex((current) =>
        (current - 1 + catchphrases.length) % catchphrases.length,
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const target = catchphrases[highlightIndex];
      if (!target) return;
      if (event.shiftKey) {
        handleSend(target);
      } else {
        handlePick(target);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label="Catchphrases"
      tabIndex={-1}
      onKeyDown={handleListKeyDown}
      data-testid="catchphrase-popover"
      className="catchphrase-popover-surface absolute bottom-full left-0 right-0 z-50 mx-4 mb-2 overflow-hidden rounded-xl border shadow-xl md:mx-6"
    >
      <div
        className="catchphrase-popover-header border-b px-3 py-2"
      >
        <p className="text-xs">
          单击填入 · 双击直接发送 · ↑↓ 选择 · Enter 填入 · Shift+Enter 发送
        </p>
      </div>
      {!hydrated && loading ? (
        <div className="catchphrase-popover-muted px-4 py-6 text-center text-sm">
          Loading...
        </div>
      ) : error && !hydrated ? (
        <div className="catchphrase-popover-muted px-4 py-6 text-center text-sm">
          <p className="mb-3">{error}</p>
          <button
            type="button"
            onClick={() => void hydrate()}
            disabled={loading}
            className="catchphrase-popover-link underline disabled:cursor-not-allowed disabled:opacity-60"
            data-testid="catchphrase-popover-retry"
          >
            重试
          </button>
        </div>
      ) : catchphrases.length === 0 ? (
        <div
          className="catchphrase-popover-muted px-4 py-6 text-center text-sm"
        >
          还没有口头禅，去
          <Link
            href="/app/settings"
            onClick={onClose}
            className="catchphrase-popover-link mx-1 underline"
            data-testid="catchphrase-popover-empty-link"
          >
            Settings
          </Link>
          添加几条
        </div>
      ) : (
        <ul className="max-h-72 overflow-y-auto" data-testid="catchphrase-popover-list">
          {catchphrases.map((row, index) => {
            const highlighted = index === highlightIndex;
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={(event) => {
                    if (event.detail > 1) return;
                    schedulePick(row);
                  }}
                  onDoubleClick={(event) => {
                    event.preventDefault();
                    handleSend(row);
                  }}
                  onMouseEnter={() => setHighlightIndex(index)}
                  data-testid={`catchphrase-popover-item-${row.id}`}
                  className={`catchphrase-popover-row w-full border-b px-3 py-2 text-left text-sm whitespace-pre-wrap break-words transition-colors last:border-b-0 ${
                    highlighted ? 'catchphrase-popover-row-active' : ''
                  }`}
                >
                  <span className="line-clamp-2">{row.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

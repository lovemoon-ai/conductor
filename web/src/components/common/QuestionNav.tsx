'use client';

import { useEffect, useRef } from 'react';

interface QuestionNavProps {
  /** Number of dots to render. Returns null when 0. */
  count: number;
  /** Currently active dot index (0-based). */
  activeIndex: number;
  /** Click handler for a dot. Receives the dot's 0-based index. */
  onJump: (index: number) => void;
  /**
   * When false the nav fades to opacity 0, becomes non-interactive
   * (pointer-events-none), and removes its buttons from the tab order.
   * Defaults to true so callers that don't need toggleable visibility don't
   * have to manage a flag.
   */
  visible?: boolean;
  /**
   * Override the outer nav positioning. Each call site decides whether to
   * pin to the viewport (`fixed right-N`) or to a scroll container
   * (`absolute right-N`). Only the positioning *mode* and horizontal offset
   * need to be supplied — vertical centering (`top-1/2 -translate-y-1/2`)
   * is owned by the component so the two pieces never drift apart.
   * Defaults to a viewport-fixed layout for the simple share-page use case.
   */
  className?: string;
}

const DEFAULT_POSITION_CLASS = 'fixed right-4';
// Vertical centering lives here intentionally: `-translate-y-1/2` only makes
// sense paired with `top-1/2`, so we keep them together rather than risk a
// caller passing one without the other.
const BASE_CLASS =
  'top-1/2 z-20 -translate-y-1/2 flex max-h-[80%] flex-col items-center overflow-y-auto py-1 transition-opacity duration-200';

/**
 * Vertical column of dots that lets users quick-jump between user messages
 * in a conversation. Shared by the share page and the in-app chat view.
 *
 * Visibility is opacity-driven so the layout doesn't reflow when the nav
 * toggles, and `tabIndex` is also flipped so hidden buttons don't trap
 * keyboard focus.
 */
export function QuestionNav({
  count,
  activeIndex,
  onJump,
  visible = true,
  className,
}: QuestionNavProps) {
  // Per-dot refs let us nudge the active dot back into the rail's own scroll
  // viewport when the conversation has more dots than fit in `max-h-[80%]`.
  // Without this the nav silently hides the active dot behind its internal
  // scrollbar and users have to scroll the rail by hand to find it.
  const buttonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    // While the nav is hidden (opacity-0 / pointer-events-none) scrolling it
    // serves no purpose — and `scrollIntoView` on a non-visible element can
    // perturb ancestor scroll containers. Defer until the rail comes back.
    if (!visible) return;
    const node = buttonRefs.current.get(activeIndex);
    if (!node) return;
    // `block: 'nearest'` is intentional: the browser leaves the rail alone
    // when the active dot is already in view, and only scrolls the minimum
    // distance needed when it isn't. Anything stronger (`center` / `start`)
    // would yank the rail every time the user scrolls past a new question,
    // which we explicitly don't want.
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex, visible, count]);

  if (count === 0) return null;

  const positionClass = className ?? DEFAULT_POSITION_CLASS;
  const visibilityClass = visible
    ? 'opacity-100 pointer-events-auto'
    : 'opacity-0 pointer-events-none';

  return (
    <nav
      aria-label="Jump to question"
      aria-hidden={!visible}
      className={`${BASE_CLASS} ${positionClass} ${visibilityClass}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex flex-col items-center">
          {i > 0 && <div className="h-3 w-px bg-neutral-400/60" />}
          <button
            type="button"
            ref={(node) => {
              if (node) {
                buttonRefs.current.set(i, node);
              } else {
                buttonRefs.current.delete(i);
              }
            }}
            tabIndex={visible ? 0 : -1}
            aria-label={`Jump to question ${i + 1}`}
            title={`Question ${i + 1}`}
            onClick={() => onJump(i)}
            className="flex h-6 w-6 items-center justify-center"
          >
            <span
              className={`block rounded-full transition-all ${
                activeIndex === i
                  ? 'h-3 w-3 bg-[var(--accent)]'
                  : 'h-1.5 w-1.5 bg-neutral-400 hover:bg-neutral-600'
              }`}
            />
          </button>
        </div>
      ))}
    </nav>
  );
}

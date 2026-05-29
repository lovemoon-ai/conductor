/**
 * QuestionNav: a vertical column of dots that lets users quick-jump between
 * their own messages ("questions") in a long conversation.
 *
 * This is the SDK-local port of the main app's
 * `web/src/components/common/QuestionNav.tsx`. The behavior is identical;
 * only the styling layer differs — the main app uses Tailwind utility
 * classes, while the SDK renders semantic `conductor-*` classes so hosts can
 * theme/override every piece without forking the widget (see styles.css).
 *
 * Visibility is opacity-driven so toggling the rail never reflows the message
 * list, and `tabIndex` is flipped in lock-step so hidden dots don't trap
 * keyboard focus.
 */
import { useEffect, useRef } from 'react';

export interface QuestionNavProps {
  /** Number of dots to render. Renders nothing when 0. */
  count: number;
  /** Currently active dot index (0-based). */
  activeIndex: number;
  /** Click handler for a dot. Receives the dot's 0-based index. */
  onJump: (index: number) => void;
  /**
   * When false the rail fades to opacity 0, becomes non-interactive, and
   * removes its buttons from the tab order. Defaults to true.
   */
  visible?: boolean;
  /**
   * Accessible label prefix. The nav's `aria-label` is this string; each dot
   * is labelled `"{label} {n}"`. Defaults to English.
   */
  label?: string;
}

export function QuestionNav({
  count,
  activeIndex,
  onJump,
  visible = true,
  label = 'Jump to question',
}: QuestionNavProps) {
  // Per-dot refs let us nudge the active dot back into the rail's own scroll
  // viewport when the conversation has more dots than fit in `max-height`.
  const buttonRefs = useRef<Map<number, HTMLButtonElement>>(new Map());

  useEffect(() => {
    // Scrolling a hidden (opacity-0 / pointer-events-none) rail serves no
    // purpose and `scrollIntoView` on a non-visible element can perturb
    // ancestor scroll containers — defer until it comes back.
    if (!visible) return;
    const node = buttonRefs.current.get(activeIndex);
    if (!node || typeof node.scrollIntoView !== 'function') return;
    // `nearest` keeps the rail still when the active dot is already in view
    // and only scrolls the minimum distance otherwise.
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeIndex, visible, count]);

  if (count === 0) return null;

  const visibilityClass = visible
    ? 'conductor-question-nav--visible'
    : 'conductor-question-nav--hidden';

  return (
    <nav
      aria-label={label}
      aria-hidden={!visible}
      className={`conductor-question-nav ${visibilityClass}`}
    >
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="conductor-question-nav__group">
          {i > 0 && <span className="conductor-question-nav__sep" aria-hidden="true" />}
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
            aria-label={`${label} ${i + 1}`}
            title={`${i + 1}`}
            onClick={() => onJump(i)}
            className="conductor-question-nav__btn"
          >
            <span
              className={
                'conductor-question-nav__dot' +
                (activeIndex === i ? ' conductor-question-nav__dot--active' : '')
              }
            />
          </button>
        </div>
      ))}
    </nav>
  );
}

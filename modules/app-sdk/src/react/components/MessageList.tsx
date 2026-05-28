/**
 * MessageList: scrollable list of message bubbles for the current task.
 *
 * Beyond rendering bubbles, this component owns the navigation + history
 * affordances ported from the main app's ChatView so the embeddable widget
 * reaches parity:
 *
 *   1. Anchor navigation (QuestionNav) — a vertical rail of dots that quick-
 *      jumps between the user's own messages. Appears when the user scrolls
 *      up (toward history) and there is more than one question.
 *   2. Scroll-to-bottom button — a floating "jump to latest" button shown when
 *      the user has scrolled away from the bottom of a scrollable transcript.
 *   3. Double-click action menu — a contained bottom-sheet (copy / resend /
 *      interrupt / restart) opened from a bubble. State is lifted here so the
 *      sheet paints once over the whole scroll area and never gets clipped.
 *   4. Scroll-position persistence — per-task scrollTop + stick-to-bottom is
 *      remembered in sessionStorage and restored on remount / task switch.
 *   5. Infinite history — scrolling to the top auto-loads older messages while
 *      anchoring the viewport so the content under the user's eyes doesn't
 *      jump, and keeps loading until the viewport is filled.
 *   6. Empty state — a friendly placeholder (with an optional restart button
 *      when the adapter supports it) instead of a blank panel.
 *
 * Bubble *containers* are owned by the SDK; the rendered *content inside* each
 * bubble is plain text by default but pluggable via `renderMessageContent`.
 */
import type { ReactNode } from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useChat } from '../store/chat-store.js';
import type { ChatViewLabels } from '../ChatView.js';
import type { Message } from '../../types/message.js';
import { MessageBubble } from './MessageBubble.js';
import { QuestionNav } from './QuestionNav.js';

/**
 * Custom content renderer. Receives the full `Message` so the renderer can
 * branch on `role` / `metadata` / `attachments` if it wants to. Return any
 * ReactNode; the SDK still wraps it in `<div class="conductor-bubble">` and
 * applies role-based alignment / pending styling.
 */
export type RenderMessageContent = (message: Message) => ReactNode;

export interface MessageListProps {
  labels: ChatViewLabels;
  /**
   * Optional override for how each message's content is rendered inside its
   * bubble. Defaults to plain text (`message.content`).
   */
  renderMessageContent?: RenderMessageContent;
  /** Forwarded to each bubble; see MessageBubble. */
  showAppOriginChip?: boolean;
  /**
   * When true, hide mutating actions (resend / interrupt / restart, including
   * the empty-state restart button). Copy stays available. Mirrors the
   * `readOnly` ChatView prop.
   */
  readOnly?: boolean;
}

const SCROLL_STORAGE_PREFIX = 'conductor-sdk-task-scroll:';
// Distance from the bottom that still counts as "stuck to bottom".
const SCROLL_BOTTOM_THRESHOLD_PX = 40;
// Scrolling within this many px of the top triggers an older-history load.
const SCROLL_TOP_LOAD_THRESHOLD_PX = 24;
// Minimum overflow before the floating jump-to-latest button is worth showing.
const SCROLL_TO_BOTTOM_BUTTON_MIN_OVERFLOW_PX = 40;
// Scroll delta required before a scroll counts as an intentional directional
// change (vs. inertial bounce / sub-pixel reflow). Keeps the rail from
// flickering.
const SCROLL_DIRECTION_THRESHOLD_PX = 4;
// Offset used when picking the "active" question dot.
const QUESTION_ACTIVE_OFFSET_PX = 80;
// Breathing room left above a question when quick-jumping to it.
const QUESTION_JUMP_TOP_PADDING_PX = 12;
// How long the "Copied" confirmation stays before the sheet closes.
const COPY_FEEDBACK_MS = 1500;
// Trailing-debounce window for persisting scroll position to sessionStorage.
// Scroll affordances update synchronously; only the storage write is delayed.
const SCROLL_PERSIST_DEBOUNCE_MS = 150;

interface StoredScrollState {
  scrollTop: number;
  stickToBottom: boolean;
}

const getScrollStorageKey = (taskId: string) => `${SCROLL_STORAGE_PREFIX}${taskId}`;

const getMaxScrollTop = (el: HTMLElement) => Math.max(0, el.scrollHeight - el.clientHeight);

const clampScrollTop = (el: HTMLElement, scrollTop: number) =>
  Math.min(Math.max(scrollTop, 0), getMaxScrollTop(el));

const isNearBottom = (el: HTMLElement) =>
  getMaxScrollTop(el) - el.scrollTop <= SCROLL_BOTTOM_THRESHOLD_PX;

// User-side messages (the human's own turns, including SDK-authored ones that
// render on the user side) are the anchor targets for QuestionNav.
const isUserSide = (m: Message) => m.role === 'user' || m.role === 'sdk';

const readStoredScrollState = (taskId: string): StoredScrollState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(getScrollStorageKey(taskId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isFinite(parsed.scrollTop) &&
      typeof parsed.stickToBottom === 'boolean'
    ) {
      return { scrollTop: Math.max(0, parsed.scrollTop), stickToBottom: parsed.stickToBottom };
    }
  } catch {
    // ignore storage errors
  }
  return null;
};

const writeStoredScrollState = (taskId: string, state: StoredScrollState) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(getScrollStorageKey(taskId), JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
};

/** Copy text to the clipboard with a legacy execCommand fallback. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    document.body.removeChild(textarea);
    return Boolean(ok);
  } catch {
    return false;
  }
}

export function MessageList({
  labels,
  renderMessageContent,
  showAppOriginChip,
  readOnly = false,
}: MessageListProps) {
  const { state, loadEarlier, send, interrupt, restart, restartSupported, taskId } = useChat();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showQuestionNav, setShowQuestionNav] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [menuMessage, setMenuMessage] = useState<Message | null>(null);
  const [copied, setCopied] = useState(false);
  const [restartPending, setRestartPending] = useState(false);

  // Per-question (user message) row refs, keyed by question index.
  const questionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isJumpingRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const activeQuestionRafRef = useRef<number | null>(null);
  const copyTimeoutRef = useRef<number | null>(null);
  // Debounced scroll-write bookkeeping (F5).
  const scrollWriteTimerRef = useRef<number | null>(null);
  const pendingScrollStateRef = useRef<StoredScrollState | null>(null);

  // Scroll restore / history-anchoring bookkeeping (ported from the main app).
  const previousMessageCountRef = useRef(state.messages.length);
  const pendingRestoreScrollStateRef = useRef<StoredScrollState | null>(null);
  const pendingPrependAnchorRef = useRef<{ previousScrollHeight: number; previousScrollTop: number } | null>(null);
  const autoLoadUntilFilledRef = useRef(false);
  const shouldRestoreScrollRef = useRef(true);
  const shouldStickToBottomRef = useRef(true);

  const messages = state.messages;
  const hasMoreBefore = state.hasMoreBefore;
  const oldestMessageId = state.oldestMessageId;
  const loadingHistory = state.loadingHistory;
  const replyInProgress = state.runtime?.replyInProgress === true;
  const canInterrupt = replyInProgress && Boolean(state.latestReplyId);

  // Map message id → question index (0-based, only user-side messages).
  const questionIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let q = 0;
    for (const m of messages) {
      if (isUserSide(m)) {
        map.set(m.id, q);
        q += 1;
      }
    }
    return map;
  }, [messages]);
  const userQuestionCount = questionIndexById.size;

  // Flush any debounced scroll write immediately. With no override it writes
  // the pending state (or the live position) — used on task switch / unmount /
  // scroll-to-bottom so a position is never lost in the debounce window.
  const writeScrollNow = useCallback(
    (override?: StoredScrollState) => {
      if (scrollWriteTimerRef.current !== null) {
        window.clearTimeout(scrollWriteTimerRef.current);
        scrollWriteTimerRef.current = null;
      }
      const el = containerRef.current;
      const next =
        override ??
        pendingScrollStateRef.current ??
        (el
          ? { scrollTop: clampScrollTop(el, el.scrollTop), stickToBottom: isNearBottom(el) }
          : null);
      pendingScrollStateRef.current = null;
      if (next) writeStoredScrollState(taskId, next);
    },
    [taskId],
  );

  const persistScroll = useCallback(
    (scrollTop?: number) => {
      const el = containerRef.current;
      if (!el) return;
      const next =
        typeof scrollTop === 'number'
          ? clampScrollTop(el, scrollTop)
          : clampScrollTop(el, el.scrollTop);
      const stick = isNearBottom(el);
      const canScroll = getMaxScrollTop(el) > SCROLL_TO_BOTTOM_BUTTON_MIN_OVERFLOW_PX;
      // Affordances update synchronously every tick…
      shouldStickToBottomRef.current = stick;
      setShowScrollToBottom(canScroll && !stick);
      // …but the sessionStorage write is debounced: a synchronous write per
      // scroll event is wasteful (F5). Persist the latest position ~150ms after
      // motion settles; flushed eagerly via writeScrollNow().
      pendingScrollStateRef.current = { scrollTop: next, stickToBottom: stick };
      if (scrollWriteTimerRef.current === null) {
        scrollWriteTimerRef.current = window.setTimeout(() => {
          scrollWriteTimerRef.current = null;
          if (pendingScrollStateRef.current) {
            writeStoredScrollState(taskId, pendingScrollStateRef.current);
            pendingScrollStateRef.current = null;
          }
        }, SCROLL_PERSIST_DEBOUNCE_MS);
      }
    },
    [taskId],
  );

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const next = getMaxScrollTop(el);
    // Seed the direction baseline before mutating scrollTop — some browsers
    // dispatch `scroll` synchronously on assignment.
    lastScrollTopRef.current = next;
    el.scrollTop = next;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setShowQuestionNav(false);
    writeScrollNow({ scrollTop: next, stickToBottom: true });
  }, [writeScrollNow]);

  const handleJumpToQuestion = useCallback((questionIndex: number) => {
    const node = questionRefs.current.get(questionIndex);
    const el = containerRef.current;
    if (!node || !el) return;
    isJumpingRef.current = true;
    const containerTop = el.getBoundingClientRect().top;
    const elTop = node.getBoundingClientRect().top;
    const next = clampScrollTop(
      el,
      el.scrollTop + (elTop - containerTop) - QUESTION_JUMP_TOP_PADDING_PX,
    );
    lastScrollTopRef.current = next;
    el.scrollTop = next;
    setActiveQuestion(questionIndex);
    window.setTimeout(() => {
      isJumpingRef.current = false;
    }, 120);
  }, []);

  const loadOlder = useCallback(
    async (options?: { continueUntilFilled?: boolean }) => {
      if (!oldestMessageId || loadingHistory) return;
      if (options?.continueUntilFilled) autoLoadUntilFilledRef.current = true;
      const el = containerRef.current;
      if (el) {
        pendingPrependAnchorRef.current = {
          previousScrollHeight: el.scrollHeight,
          previousScrollTop: el.scrollTop,
        };
      }
      await loadEarlier();
    },
    [oldestMessageId, loadingHistory, loadEarlier],
  );

  const maybeContinueAutoLoad = useCallback(() => {
    const el = containerRef.current;
    if (!autoLoadUntilFilledRef.current || !el || loadingHistory) return;
    if (!hasMoreBefore || !oldestMessageId) {
      autoLoadUntilFilledRef.current = false;
      return;
    }
    if (el.scrollHeight > el.clientHeight + SCROLL_TOP_LOAD_THRESHOLD_PX) {
      autoLoadUntilFilledRef.current = false;
      return;
    }
    void loadOlder({ continueUntilFilled: true });
  }, [loadingHistory, hasMoreBefore, oldestMessageId, loadOlder]);

  const handleScroll = useCallback(() => {
    persistScroll();
    const el = containerRef.current;
    if (!el) return;

    const current = el.scrollTop;
    const delta = current - lastScrollTopRef.current;

    // Toggle the rail on intentional directional scroll.
    if (!isJumpingRef.current && userQuestionCount > 1) {
      if (delta <= -SCROLL_DIRECTION_THRESHOLD_PX) {
        setShowQuestionNav(true);
      } else if (delta >= SCROLL_DIRECTION_THRESHOLD_PX) {
        setShowQuestionNav(false);
      }
    }

    // Recompute the active dot at most once per frame.
    if (
      !isJumpingRef.current &&
      questionRefs.current.size > 0 &&
      activeQuestionRafRef.current === null
    ) {
      activeQuestionRafRef.current = window.requestAnimationFrame(() => {
        activeQuestionRafRef.current = null;
        if (isJumpingRef.current) return;
        const c = containerRef.current;
        if (!c) return;
        const containerTop = c.getBoundingClientRect().top;
        let closest = 0;
        let closestDist = Infinity;
        questionRefs.current.forEach((node, idx) => {
          const dist = Math.abs(
            node.getBoundingClientRect().top - containerTop - QUESTION_ACTIVE_OFFSET_PX,
          );
          if (dist < closestDist) {
            closestDist = dist;
            closest = idx;
          }
        });
        setActiveQuestion((cur) => (cur === closest ? cur : closest));
      });
    }

    lastScrollTopRef.current = current;

    // Auto-load older history when near the top.
    if (!hasMoreBefore || loadingHistory || !oldestMessageId) {
      if (!hasMoreBefore || !oldestMessageId) autoLoadUntilFilledRef.current = false;
      return;
    }
    if (current <= SCROLL_TOP_LOAD_THRESHOLD_PX) {
      void loadOlder({ continueUntilFilled: true });
      return;
    }
    autoLoadUntilFilledRef.current = false;
  }, [persistScroll, userQuestionCount, hasMoreBefore, loadingHistory, oldestMessageId, loadOlder]);

  // Reset scroll bookkeeping when the conversation (task) changes. Runs before
  // the positioning layout effect below thanks to declaration order.
  useLayoutEffect(() => {
    pendingRestoreScrollStateRef.current = readStoredScrollState(taskId);
    pendingPrependAnchorRef.current = null;
    autoLoadUntilFilledRef.current = false;
    shouldRestoreScrollRef.current = true;
    shouldStickToBottomRef.current = true;
    previousMessageCountRef.current = messages.length;
    questionRefs.current = new Map();
    isJumpingRef.current = false;
    lastScrollTopRef.current = 0;
    if (activeQuestionRafRef.current !== null) {
      window.cancelAnimationFrame(activeQuestionRafRef.current);
      activeQuestionRafRef.current = null;
    }
    setShowScrollToBottom(false);
    setShowQuestionNav(false);
    setActiveQuestion(0);
    setMenuMessage(null);
    setCopied(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Positioning: anchor on prepend, restore on first paint, stick to bottom on
  // growth.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    if (pendingPrependAnchorRef.current) {
      const { previousScrollHeight, previousScrollTop } = pendingPrependAnchorRef.current;
      const delta = el.scrollHeight - previousScrollHeight;
      const next = clampScrollTop(el, previousScrollTop + delta);
      lastScrollTopRef.current = next;
      el.scrollTop = next;
      persistScroll(next);
      pendingPrependAnchorRef.current = null;
      previousMessageCountRef.current = messages.length;
      maybeContinueAutoLoad();
      return;
    }

    if (shouldRestoreScrollRef.current) {
      if (loadingHistory && messages.length === 0) return;
      const stored = pendingRestoreScrollStateRef.current;
      if (stored?.stickToBottom) {
        scrollToBottom();
      } else if (stored) {
        const next = clampScrollTop(el, stored.scrollTop);
        lastScrollTopRef.current = next;
        el.scrollTop = next;
        persistScroll(next);
      } else {
        scrollToBottom();
      }
      shouldRestoreScrollRef.current = false;
      pendingRestoreScrollStateRef.current = null;
      previousMessageCountRef.current = messages.length;
      maybeContinueAutoLoad();
      return;
    }

    const prevCount = previousMessageCountRef.current;
    if (messages.length > prevCount) {
      const lastMsg = messages[messages.length - 1];
      // Snap to bottom when the user is already reading the tail, or when THIS
      // client just sent — detected by the optimistic `pending:` id. A user
      // message arriving from another tab/client (a real id) must NOT yank a
      // user who is scrolled up reading history (F3).
      const localSend = lastMsg ? isUserSide(lastMsg) && lastMsg.id.startsWith('pending:') : false;
      if (shouldStickToBottomRef.current || localSend) {
        scrollToBottom();
      } else {
        persistScroll();
      }
    } else {
      persistScroll();
    }
    previousMessageCountRef.current = messages.length;
    maybeContinueAutoLoad();
  }, [loadingHistory, messages.length, taskId, persistScroll, scrollToBottom, maybeContinueAutoLoad]);

  // Flush the latest scroll position synchronously on unmount / before a task
  // switch, so the debounced write isn't lost.
  useEffect(
    () => () => {
      writeScrollNow();
    },
    [taskId, writeScrollNow],
  );

  // Cancel any in-flight rAF / timers on unmount.
  useEffect(
    () => () => {
      if (activeQuestionRafRef.current !== null) {
        window.cancelAnimationFrame(activeQuestionRafRef.current);
        activeQuestionRafRef.current = null;
      }
      if (copyTimeoutRef.current !== null) {
        window.clearTimeout(copyTimeoutRef.current);
        copyTimeoutRef.current = null;
      }
      if (scrollWriteTimerRef.current !== null) {
        window.clearTimeout(scrollWriteTimerRef.current);
        scrollWriteTimerRef.current = null;
      }
    },
    [],
  );

  const closeMenu = useCallback(() => {
    if (copyTimeoutRef.current !== null) {
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    setCopied(false);
    setMenuMessage(null);
  }, []);

  const openMenu = useCallback((message: Message) => {
    if (copyTimeoutRef.current !== null) {
      window.clearTimeout(copyTimeoutRef.current);
      copyTimeoutRef.current = null;
    }
    setCopied(false);
    setMenuMessage(message);
  }, []);

  // Close the menu on Escape.
  useEffect(() => {
    if (!menuMessage) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [menuMessage, closeMenu]);

  const handleCopy = useCallback(async () => {
    if (!menuMessage) return;
    const ok = await copyText(menuMessage.content);
    if (!ok) {
      closeMenu();
      return;
    }
    setCopied(true);
    copyTimeoutRef.current = window.setTimeout(() => {
      closeMenu();
    }, COPY_FEEDBACK_MS);
  }, [menuMessage, closeMenu]);

  const handleResend = useCallback(() => {
    if (!menuMessage || !menuMessage.content.trim()) return;
    void send(menuMessage.content);
    closeMenu();
  }, [menuMessage, send, closeMenu]);

  const handleInterrupt = useCallback(() => {
    void interrupt();
    closeMenu();
  }, [interrupt, closeMenu]);

  const handleRestart = useCallback(async () => {
    if (!restartSupported || restartPending) return;
    setRestartPending(true);
    closeMenu();
    try {
      await restart({ restartMode: 'refresh_session' });
    } finally {
      setRestartPending(false);
    }
  }, [restartSupported, restartPending, restart, closeMenu]);

  const menuIsUserSide = menuMessage ? isUserSide(menuMessage) : false;
  const showEmptyState = messages.length === 0 && !loadingHistory;

  return (
    <div className="conductor-message-list-viewport">
      <div
        ref={containerRef}
        className="conductor-message-list"
        role="log"
        aria-live="polite"
        onScroll={handleScroll}
      >
        {hasMoreBefore && (
          <div className="conductor-load-earlier">
            <button
              type="button"
              onClick={() => {
                void loadOlder({ continueUntilFilled: true });
              }}
              disabled={loadingHistory}
            >
              {loadingHistory ? '…' : labels.loadEarlier}
            </button>
          </div>
        )}

        {showEmptyState ? (
          <div className="conductor-empty">
            <svg
              className="conductor-empty__icon"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
              />
            </svg>
            <p className="conductor-empty__title">{labels.emptyTitle}</p>
            <p className="conductor-empty__body">{labels.emptyBody}</p>
            {restartSupported && !readOnly ? (
              <button
                type="button"
                className="conductor-button conductor-empty__restart"
                data-testid="conductor-empty-restart"
                disabled={restartPending}
                onClick={() => {
                  void handleRestart();
                }}
              >
                {restartPending ? labels.restartPending : labels.restart}
              </button>
            ) : null}
          </div>
        ) : null}

        {messages.map((m) => {
          const isUser = isUserSide(m);
          const isPending = m.id.startsWith('pending:');
          const qIdx = questionIndexById.get(m.id);
          return (
            <div
              key={m.id}
              ref={(node) => {
                if (qIdx == null) return;
                if (node) {
                  questionRefs.current.set(qIdx, node);
                } else {
                  questionRefs.current.delete(qIdx);
                }
              }}
              className={
                'conductor-message ' +
                (isUser ? 'conductor-message--user' : 'conductor-message--assistant') +
                (isPending ? ' conductor-message--pending' : '')
              }
              data-role={m.role}
              data-message-id={m.id}
            >
              <MessageBubble
                message={m}
                renderMessageContent={renderMessageContent}
                onRequestMenu={openMenu}
                showAppOriginChip={showAppOriginChip}
              />
            </div>
          );
        })}
      </div>

      <QuestionNav
        count={userQuestionCount}
        activeIndex={activeQuestion}
        visible={showQuestionNav && userQuestionCount > 1}
        onJump={handleJumpToQuestion}
        label={labels.jumpToQuestion}
      />

      {showScrollToBottom && (
        <button
          type="button"
          className="conductor-scroll-to-bottom"
          aria-label={labels.scrollToBottom}
          data-testid="conductor-scroll-to-bottom"
          onClick={scrollToBottom}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="m19 12-7 7-7-7" />
          </svg>
        </button>
      )}

      {menuMessage && (
        <div
          className="conductor-bubble-menu-overlay"
          onClick={closeMenu}
          data-testid="conductor-bubble-menu"
        >
          <div className="conductor-bubble-menu-backdrop" />
          <div
            className="conductor-bubble-menu-sheet"
            role="menu"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="conductor-bubble-menu-handle" aria-hidden="true" />
            <div className="conductor-bubble-menu-actions">
              <button
                type="button"
                className="conductor-bubble-menu-item"
                data-testid="conductor-bubble-menu-copy"
                onClick={() => {
                  void handleCopy();
                }}
              >
                {copied ? labels.copied : labels.copy}
              </button>
              {menuIsUserSide && !readOnly && (
                <button
                  type="button"
                  className="conductor-bubble-menu-item"
                  data-testid="conductor-bubble-menu-resend"
                  disabled={!menuMessage.content.trim()}
                  onClick={handleResend}
                >
                  {labels.resend}
                </button>
              )}
              {canInterrupt && !readOnly && (
                <button
                  type="button"
                  className="conductor-bubble-menu-item"
                  data-testid="conductor-bubble-menu-interrupt"
                  onClick={handleInterrupt}
                >
                  {labels.interrupt}
                </button>
              )}
              {restartSupported && !readOnly && (
                <button
                  type="button"
                  className="conductor-bubble-menu-item"
                  data-testid="conductor-bubble-menu-restart"
                  disabled={restartPending}
                  onClick={() => {
                    void handleRestart();
                  }}
                >
                  {restartPending ? labels.restartPending : labels.restart}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

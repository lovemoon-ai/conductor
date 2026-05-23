/**
 * MessageList: scrollable list of message bubbles for the current task.
 *
 * v0.1 implementation: functional but visually minimal. Bubble *containers*
 * (role-based alignment, pending state, data attributes) are owned by the
 * SDK; the rendered *content inside* each bubble is plain text by default
 * but pluggable via `renderMessageContent` so hosts can wire in markdown,
 * syntax highlighting, math, or anything else without forking the widget.
 *
 * Adding markdown directly here would force every consumer to pay the
 * react-markdown bundle cost (~150KB) whether they want it or not, and
 * pre-decides which markdown library wins. The slot keeps the SDK lean
 * and lets each app pick its own renderer.
 */
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useChat } from '../store/chat-store.js';
import type { ChatViewLabels } from '../ChatView.js';
import type { Message } from '../../types/message.js';

/**
 * Custom content renderer. Receives the full `Message` so the renderer can
 * branch on `role` / `metadata` / `attachments` if it wants to. Return any
 * ReactNode; the SDK still wraps it in `<div class="conductor-bubble">` and
 * applies role-based alignment / pending styling.
 *
 * Returning `null` (or `undefined`) renders an empty bubble — equivalent to
 * a message with empty content. If you want to suppress the bubble entirely,
 * filter the message upstream (e.g. via your own MessageList).
 */
export type RenderMessageContent = (message: Message) => ReactNode;

export interface MessageListProps {
  labels: ChatViewLabels;
  /**
   * Optional override for how each message's content is rendered inside its
   * bubble. Defaults to plain text (`message.content`). Pass e.g. a
   * `react-markdown` renderer here to enable markdown formatting:
   *
   *   <MessageList
   *     labels={...}
   *     renderMessageContent={(m) => (
   *       <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
   *     )}
   *   />
   */
  renderMessageContent?: RenderMessageContent;
}

export function MessageList({ labels, renderMessageContent }: MessageListProps) {
  const { state, loadEarlier } = useChat();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const lastMessageCountRef = useRef(state.messages.length);

  // Auto-scroll to bottom when new messages arrive, unless the user has
  // scrolled up to read history (then we leave their scroll position alone).
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const grew = state.messages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = state.messages.length;
    if (!grew) return;
    const distanceFromBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight;
    // Heuristic: if the user is within 120px of the bottom, snap.
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.messages.length]);

  // On first paint, scroll to bottom unconditionally.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div ref={containerRef} className="conductor-message-list" role="log" aria-live="polite">
      {state.hasMoreBefore && (
        <div className="conductor-load-earlier">
          <button
            type="button"
            onClick={() => {
              void loadEarlier();
            }}
            disabled={state.loadingHistory}
          >
            {state.loadingHistory ? '…' : labels.loadEarlier}
          </button>
        </div>
      )}
      {state.messages.length === 0 && !state.loadingHistory && (
        <div className="conductor-empty">{/* deliberately blank for v0.1 */}</div>
      )}
      {state.messages.map((m) => {
        const isUser = m.role === 'user' || m.role === 'sdk';
        const isPending = m.id.startsWith('pending:');
        // Default to plain text so consumers without a custom renderer keep
        // the v0.1 behavior. The render-prop is intentionally NOT memoized
        // here — wrapping it in useCallback would force every consumer to
        // do the same to avoid spurious re-renders, and message-bubble
        // content rendering is not a hot path.
        const content = renderMessageContent
          ? renderMessageContent(m)
          : m.content;
        return (
          <div
            key={m.id}
            className={
              'conductor-message ' +
              (isUser ? 'conductor-message--user' : 'conductor-message--assistant') +
              (isPending ? ' conductor-message--pending' : '')
            }
            data-role={m.role}
            data-message-id={m.id}
          >
            <div className="conductor-bubble">{content}</div>
          </div>
        );
      })}
    </div>
  );
}

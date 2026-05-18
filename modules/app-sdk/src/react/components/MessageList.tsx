/**
 * MessageList: scrollable list of message bubbles for the current task.
 *
 * v0.1 implementation: functional but visually minimal. The eventual
 * extraction from `web/src/features/chat/components/MessageBubble.tsx` will
 * bring in markdown rendering, attachments, and the polished bubble styling.
 * For now we render plain text bubbles with role-based alignment so the
 * widget is usable end-to-end without external dependencies.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useChat } from '../store/chat-store.js';
import type { ChatViewLabels } from '../ChatView.js';

export interface MessageListProps {
  labels: ChatViewLabels;
}

export function MessageList({ labels }: MessageListProps) {
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
            <div className="conductor-bubble">{m.content}</div>
          </div>
        );
      })}
    </div>
  );
}

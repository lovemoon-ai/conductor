/**
 * RuntimeStatusBar: shows what the AI is doing right now
 * (thinking / calling tools / awaiting input / etc.) + a small connection
 * indicator.
 *
 * v0.1: text-only. The eventual extraction from main app brings in the
 * animated dots, token usage gauge, and tool-call breadcrumbs.
 */
import { useChat } from '../store/chat-store.js';
import type { ChatViewLabels } from '../ChatView.js';

export interface RuntimeStatusBarProps {
  labels: ChatViewLabels;
}

export function RuntimeStatusBar({ labels }: RuntimeStatusBarProps) {
  const { state } = useChat();
  const runtime = state.runtime;
  const isThinking = runtime?.replyInProgress === true || runtime?.state === 'thinking';
  const text = pickStatusText(runtime?.state, runtime?.statusLine, labels);

  const showConnection =
    state.connectionState !== 'connected' && state.connectionState !== 'offline';
  // 'offline' before first connect is uninformative noise — we show only the
  // reconnect spinner once we've started bouncing.

  return (
    <div className="conductor-runtime-status" role="status" aria-live="polite">
      <span
        className={
          'conductor-runtime-indicator' +
          (isThinking ? ' conductor-runtime-indicator--active' : '')
        }
        aria-hidden="true"
      />
      <span className="conductor-runtime-text">{text}</span>
      {state.error && (
        <span className="conductor-runtime-error" role="alert">
          {state.error.message}
        </span>
      )}
      {showConnection && (
        <span className="conductor-runtime-connection">
          {state.connectionState === 'reconnecting' ? '…' : ''}
        </span>
      )}
    </div>
  );
}

function pickStatusText(
  state: string | undefined,
  statusLine: string | null | undefined,
  labels: ChatViewLabels,
): string {
  if (statusLine) return statusLine;
  switch (state) {
    case 'thinking':
      return labels.statusThinking;
    case 'tool_call':
      return labels.statusToolCall;
    case 'awaiting_user':
      return labels.statusAwaitingUser;
    case 'done':
      return labels.statusDone;
    default:
      return '';
  }
}

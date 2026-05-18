/**
 * MessageInput: textarea + send button + interrupt button (when reply in
 * progress).
 *
 * Keyboard:
 *   - Enter         → send
 *   - Shift+Enter   → newline
 *   - Cmd/Ctrl+Enter→ send (alias for users muscle-memoried to either)
 *
 * v0.1: minimal but functional. The eventual extraction from main app's
 * MessageInput.tsx (431 lines) brings ↑↓ history navigation, attachment
 * picker, draft persistence, etc.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useChat } from '../store/chat-store.js';
import type { ChatViewLabels } from '../ChatView.js';

export interface MessageInputProps {
  labels: ChatViewLabels;
  /** Disable the send button (useful while a turn is in progress). */
  disabled?: boolean;
}

export function MessageInput({ labels, disabled }: MessageInputProps) {
  const { state, send, interrupt } = useChat();
  const [value, setValue] = useState('');
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // Tracks whether an IME composition (e.g. Chinese/Japanese pinyin selection)
  // is active. Pressing Enter mid-composition picks an IME candidate; we must
  // NOT swallow it as "send" or we'd send the partial text and break the IME.
  const isComposingRef = useRef(false);

  // Auto-grow the textarea up to ~5 lines.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 5 * 24 + 16)}px`;
  }, [value]);

  const handleSend = useCallback(() => {
    if (!value.trim() || disabled) return;
    void send(value);
    setValue('');
  }, [send, value, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Some browsers report composition via `e.nativeEvent.isComposing`,
      // others only fire `compositionstart`/`compositionend`. Honor both.
      const nativeComposing = (e.nativeEvent as { isComposing?: boolean }).isComposing === true;
      if (isComposingRef.current || nativeComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);
  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
  }, []);

  const replyInProgress = state.runtime?.replyInProgress === true;
  const canInterrupt = replyInProgress && Boolean(state.latestReplyId);

  return (
    <div className="conductor-message-input">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={labels.inputPlaceholder}
        rows={1}
        className="conductor-message-input__textarea"
        disabled={disabled}
      />
      <div className="conductor-message-input__actions">
        {canInterrupt ? (
          <button
            type="button"
            className="conductor-button conductor-button--interrupt"
            onClick={() => void interrupt()}
          >
            {labels.interrupt}
          </button>
        ) : (
          <button
            type="button"
            className="conductor-button conductor-button--send"
            onClick={handleSend}
            disabled={!value.trim() || disabled}
          >
            {labels.send}
          </button>
        )}
      </div>
    </div>
  );
}

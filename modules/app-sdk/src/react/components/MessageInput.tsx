/**
 * MessageInput: textarea + send button + interrupt button (when a reply is in
 * progress).
 *
 * Parity with the main app's composer:
 *   - Enter                    → send
 *   - Shift+Enter              → newline
 *   - Cmd/Ctrl+Enter           → insert newline
 *   - ↑ / ↓ (empty modifiers)  → browse previously-sent prompts
 *   - Esc (empty input)        → interrupt the in-flight reply
 *   - Draft persistence        → per-task draft saved in sessionStorage
 *   - Auto-grow                → up to ~75% of the viewport, then scrolls
 *   - IME-safe                 → never sends mid-composition
 *
 * The ↑/↓ history is derived from the chat store's user messages (deduped by
 * content), so prompts sent from another signed-in client for the same task
 * are reachable too.
 */
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

export interface MessageInputProps {
  labels: ChatViewLabels;
  /** Disable the composer (e.g. read-only task). */
  disabled?: boolean;
  /** Focus the textarea on mount / when the task changes. */
  autoFocus?: boolean;
}

const DRAFT_STORAGE_PREFIX = 'conductor-sdk-task-draft:';
const MAX_HISTORY_ITEMS = 200;
const INPUT_SCROLL_THRESHOLD_RATIO = 0.75;
// Auto-clear the interrupt-pending state if the reply doesn't actually stop.
const INTERRUPT_PENDING_TIMEOUT_MS = 5000;

const getDraftStorageKey = (taskId: string) => `${DRAFT_STORAGE_PREFIX}${taskId}`;

// Newest→oldest list of the user's own prompts, deduped by content, then
// reversed so the last entry is the most recent (matching the ↑ cursor which
// starts at length - 1).
const deriveSentHistory = (messages: Message[]): string[] => {
  const seen = new Set<string>();
  const reversed: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') continue;
    const trimmed = (message.content ?? '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    reversed.push(trimmed);
    if (reversed.length >= MAX_HISTORY_ITEMS) break;
  }
  reversed.reverse();
  return reversed;
};

export function MessageInput({ labels, disabled, autoFocus = false }: MessageInputProps) {
  const { state, send, interrupt, taskId } = useChat();
  const [value, setValue] = useState('');
  const [interruptPending, setInterruptPending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  // IME composition guard — pressing Enter mid-composition selects a candidate,
  // so we must not treat it as "send".
  const isComposingRef = useRef(false);
  // Skip the draft-save effect on the load that follows a task switch.
  const skipDraftSaveRef = useRef(true);
  // Content-based history cursor (re-anchors even if the list shifts).
  const historyCursorRef = useRef<string | null>(null);
  const historyDraftRef = useRef('');
  const interruptTimeoutRef = useRef<number | null>(null);

  const sentHistory = useMemo(() => deriveSentHistory(state.messages), [state.messages]);

  const replyInProgress = state.runtime?.replyInProgress === true;
  const canInterrupt = replyInProgress && Boolean(state.latestReplyId);

  // Load the saved draft on mount / task switch.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    skipDraftSaveRef.current = true;
    historyCursorRef.current = null;
    historyDraftRef.current = '';
    try {
      setValue(window.sessionStorage.getItem(getDraftStorageKey(taskId)) ?? '');
    } catch {
      setValue('');
    }
  }, [taskId]);

  // Persist the draft as it changes.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (skipDraftSaveRef.current) {
      skipDraftSaveRef.current = false;
      return;
    }
    try {
      const key = getDraftStorageKey(taskId);
      if (!value) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch {
      // ignore storage errors
    }
  }, [value, taskId]);

  // Auto-grow the textarea up to ~75% of the viewport, then scroll.
  useLayoutEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const computed = window.getComputedStyle(el);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const maxHeight = Math.max(
      lineHeight * 2,
      Math.floor(window.innerHeight * INPUT_SCROLL_THRESHOLD_RATIO),
    );
    const shouldScroll = el.scrollHeight > maxHeight;
    el.style.height = `${shouldScroll ? maxHeight : el.scrollHeight}px`;
    el.style.overflowY = shouldScroll ? 'auto' : 'hidden';
  }, [value]);

  // Focus on mount / task switch when requested.
  useEffect(() => {
    if (!autoFocus || disabled) return;
    const el = taRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [autoFocus, disabled, taskId]);

  // Clear interrupt-pending once the reply actually stops.
  useEffect(() => {
    if (!replyInProgress && interruptPending) {
      setInterruptPending(false);
      if (interruptTimeoutRef.current !== null) {
        window.clearTimeout(interruptTimeoutRef.current);
        interruptTimeoutRef.current = null;
      }
    }
  }, [replyInProgress, interruptPending]);

  useEffect(
    () => () => {
      if (interruptTimeoutRef.current !== null) {
        window.clearTimeout(interruptTimeoutRef.current);
      }
    },
    [],
  );

  const moveCaretToEnd = useCallback((next?: string) => {
    const el = taRef.current;
    if (!el) return;
    const pos = (next ?? el.value).length;
    requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(pos, pos);
    });
  }, []);

  const handleSend = useCallback(() => {
    if (!value.trim() || disabled) return;
    void send(value);
    historyCursorRef.current = null;
    historyDraftRef.current = '';
    setValue('');
  }, [send, value, disabled]);

  const triggerInterrupt = useCallback(() => {
    if (!canInterrupt || interruptPending || disabled) return;
    setInterruptPending(true);
    void interrupt();
    if (interruptTimeoutRef.current !== null) window.clearTimeout(interruptTimeoutRef.current);
    interruptTimeoutRef.current = window.setTimeout(() => {
      interruptTimeoutRef.current = null;
      setInterruptPending(false);
    }, INTERRUPT_PENDING_TIMEOUT_MS);
  }, [canInterrupt, interruptPending, interrupt, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeComposing = (e.nativeEvent as { isComposing?: boolean }).isComposing === true;
      const composing = isComposingRef.current || nativeComposing;

      // ── ↑ / ↓ prompt history ──────────────────────────────────────────
      if (e.key === 'ArrowUp') {
        if (composing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (sentHistory.length === 0) return;
        e.preventDefault();
        let next: string;
        if (historyCursorRef.current === null) {
          historyDraftRef.current = value;
          next = sentHistory[sentHistory.length - 1];
        } else {
          const idx = sentHistory.lastIndexOf(historyCursorRef.current);
          if (idx === -1) next = sentHistory[sentHistory.length - 1];
          else if (idx > 0) next = sentHistory[idx - 1];
          else next = sentHistory[0];
        }
        historyCursorRef.current = next;
        setValue(next);
        moveCaretToEnd(next);
        return;
      }
      if (e.key === 'ArrowDown') {
        if (composing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (historyCursorRef.current === null) return;
        e.preventDefault();
        const idx = sentHistory.lastIndexOf(historyCursorRef.current);
        if (idx === -1 || idx >= sentHistory.length - 1) {
          historyCursorRef.current = null;
          setValue(historyDraftRef.current);
          moveCaretToEnd(historyDraftRef.current);
          return;
        }
        const next = sentHistory[idx + 1];
        historyCursorRef.current = next;
        setValue(next);
        moveCaretToEnd(next);
        return;
      }

      // ── Esc → interrupt (only when the composer is empty) ─────────────
      if (e.key === 'Escape') {
        if (composing || value.trim() || !canInterrupt || interruptPending) return;
        e.preventDefault();
        triggerInterrupt();
        return;
      }

      if (e.key !== 'Enter' || composing) return;

      // Shift+Enter inserts a newline (default textarea behavior) — don't send.
      if (e.shiftKey) return;

      // Cmd/Ctrl+Enter inserts a newline at the caret.
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const el = taRef.current;
        if (!el) return;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const next = value.slice(0, start) + '\n' + value.slice(end);
        setValue(next);
        window.setTimeout(() => {
          el.selectionStart = el.selectionEnd = start + 1;
        }, 0);
        return;
      }

      // Plain Enter sends.
      e.preventDefault();
      handleSend();
    },
    [
      sentHistory,
      value,
      canInterrupt,
      interruptPending,
      triggerInterrupt,
      handleSend,
      moveCaretToEnd,
    ],
  );

  const canSend = Boolean(value.trim()) && !disabled;

  return (
    <div className="conductor-message-input">
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false;
        }}
        placeholder={labels.inputPlaceholder}
        rows={1}
        className="conductor-message-input__textarea"
        disabled={disabled}
      />
      <div className="conductor-message-input__actions">
        {canInterrupt && !disabled ? (
          <button
            type="button"
            className="conductor-button conductor-button--interrupt"
            onClick={triggerInterrupt}
            disabled={interruptPending}
          >
            {interruptPending ? '…' : labels.interrupt}
          </button>
        ) : (
          <button
            type="button"
            className="conductor-button conductor-button--send"
            onClick={handleSend}
            disabled={!canSend}
          >
            {labels.send}
          </button>
        )}
      </div>
    </div>
  );
}

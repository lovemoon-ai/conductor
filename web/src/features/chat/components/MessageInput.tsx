'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const SEND_BUTTON_SIZE_PX = 32;
const COMPOSER_HORIZONTAL_PADDING_PX = 24;
const COMPOSER_GAP_PX = 8;
const SEND_BUTTON_SAFETY_GAP_PX = 12;
const INPUT_SCROLL_THRESHOLD_RATIO = 0.75;

const DRAFT_STORAGE_PREFIX = 'conductor-task-draft:';
const HISTORY_STORAGE_PREFIX = 'conductor-task-history:';
const MAX_HISTORY_ITEMS = 5;
const PLACEHOLDER_ROTATION_MS = 3200;
const PLACEHOLDER_MESSAGES = [
  'Type a message...',
  'Ask Conductor what to do next…',
  'Paste a concrete task to get started…',
  'Tip: use ↑ / ↓ to browse recent prompts',
] as const;

interface MessageInputProps {
  taskId: string;
  onSend: (content: string) => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  autoFocus?: boolean;
  resendRequest?: {
    id: number;
    content: string;
  } | null;
}

const getDraftStorageKey = (taskId: string) => `${DRAFT_STORAGE_PREFIX}${taskId}`;
const getHistoryStorageKey = (taskId: string) => `${HISTORY_STORAGE_PREFIX}${taskId}`;

const normalizeHistory = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(-MAX_HISTORY_ITEMS);
};

export function MessageInput({
  taskId,
  onSend,
  disabled,
  sendDisabled = false,
  autoFocus = false,
  resendRequest = null,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [isSendOnNextLine, setIsSendOnNextLine] = useState(false);
  const [isInputScrollable, setIsInputScrollable] = useState(false);
  const [sentHistory, setSentHistory] = useState<string[]>([]);
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isComposingRef = useRef(false);
  const skipStoreEffectRef = useRef(true);
  const historyCursorRef = useRef<number | null>(null);
  const historyDraftRef = useRef('');
  const lastResendRequestIdRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    skipStoreEffectRef.current = true;
    const key = getDraftStorageKey(taskId);
    try {
      const savedContent = window.sessionStorage.getItem(key);
      setContent(savedContent ?? '');
    } catch {
      // ignore storage errors
    }
  }, [taskId]);

  useEffect(() => {
    historyCursorRef.current = null;
    historyDraftRef.current = '';
    setPlaceholderIndex(0);
    if (typeof window === 'undefined') return;
    const key = getHistoryStorageKey(taskId);
    try {
      const rawHistory = window.sessionStorage.getItem(key);
      if (!rawHistory) {
        setSentHistory([]);
        return;
      }
      setSentHistory(normalizeHistory(JSON.parse(rawHistory)));
    } catch {
      setSentHistory([]);
    }
  }, [taskId]);

  useEffect(() => {
    if (content || disabled) {
      return;
    }
    const intervalId = window.setInterval(() => {
      setPlaceholderIndex((previous) => (previous + 1) % PLACEHOLDER_MESSAGES.length);
    }, PLACEHOLDER_ROTATION_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [content, disabled]);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea || disabled) {
      return;
    }
    textarea.focus({ preventScroll: true });
    const nextPosition = textarea.value.length;
    textarea.setSelectionRange(nextPosition, nextPosition);
  }, [autoFocus, disabled, taskId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (skipStoreEffectRef.current) {
      skipStoreEffectRef.current = false;
      return;
    }
    const key = getDraftStorageKey(taskId);
    try {
      if (!content) {
        window.sessionStorage.removeItem(key);
        return;
      }
      window.sessionStorage.setItem(key, content);
    } catch {
      // ignore storage errors
    }
  }, [content, taskId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const key = getHistoryStorageKey(taskId);
    try {
      if (sentHistory.length === 0) {
        window.sessionStorage.removeItem(key);
        return;
      }
      window.sessionStorage.setItem(key, JSON.stringify(sentHistory.slice(-MAX_HISTORY_ITEMS)));
    } catch {
      // ignore storage errors
    }
  }, [sentHistory, taskId]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';

    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computedStyle.lineHeight) || 20;
    const maxHeightPx = Math.max(
      lineHeight * 2,
      Math.floor(window.innerHeight * INPUT_SCROLL_THRESHOLD_RATIO),
    );
    const shouldEnableScroll = textarea.scrollHeight > maxHeightPx;
    const nextHeightPx = shouldEnableScroll ? maxHeightPx : textarea.scrollHeight;
    textarea.style.height = `${nextHeightPx}px`;
    textarea.style.overflowY = shouldEnableScroll ? 'auto' : 'hidden';
    setIsInputScrollable((previous) => (
      previous === shouldEnableScroll ? previous : shouldEnableScroll
    ));

    if (!content) {
      setIsSendOnNextLine(false);
      return;
    }

    const hasExplicitNewLine = content.includes('\n');
    const isWrappedToMultipleLines = textarea.scrollHeight > lineHeight * 1.5;

    const composerWidth = composerRef.current?.clientWidth ?? 0;
    const inlineTextWidth =
      composerWidth > COMPOSER_HORIZONTAL_PADDING_PX
        ? composerWidth - COMPOSER_HORIZONTAL_PADDING_PX - SEND_BUTTON_SIZE_PX - COMPOSER_GAP_PX
        : 0;

    let isNearSendButton = false;
    if (inlineTextWidth > 0) {
      const canvas = measureCanvasRef.current ?? document.createElement('canvas');
      measureCanvasRef.current = canvas;
      const context = canvas.getContext('2d');

      if (context) {
        context.font = computedStyle.font;
        const widestLine = content.split('\n').reduce((max, line) => {
          const width = context.measureText(line).width;
          return Math.max(max, width);
        }, 0);

        isNearSendButton = widestLine >= inlineTextWidth - SEND_BUTTON_SAFETY_GAP_PX;
      }
    }

    const nextLayout = hasExplicitNewLine || isWrappedToMultipleLines || isNearSendButton;
    setIsSendOnNextLine((previous) => (previous === nextLayout ? previous : nextLayout));
  }, [content, isInputScrollable, isSendOnNextLine]);

  const canSend = Boolean(content.trim()) && !disabled && !sendDisabled;

  const moveCaretToEnd = useCallback((nextValue?: string) => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const nextPosition = (nextValue ?? textarea.value).length;
    requestAnimationFrame(() => {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(nextPosition, nextPosition);
    });
  }, []);

  const submitContent = useCallback((nextContent: string) => {
    if (!nextContent.trim() || disabled || sendDisabled) return false;
    const trimmedContent = nextContent.trim();
    onSend(trimmedContent);
    setSentHistory((previous) => {
      const deduped = previous.filter((item) => item !== trimmedContent);
      return [...deduped, trimmedContent].slice(-MAX_HISTORY_ITEMS);
    });
    historyCursorRef.current = null;
    historyDraftRef.current = '';
    setContent('');
    return true;
  }, [disabled, onSend, sendDisabled]);

  useEffect(() => {
    if (!resendRequest || lastResendRequestIdRef.current === resendRequest.id) {
      return;
    }

    lastResendRequestIdRef.current = resendRequest.id;
    const nextContent = resendRequest.content;
    setContent(nextContent);
    historyCursorRef.current = null;
    historyDraftRef.current = '';

    const didSubmit = submitContent(nextContent);
    if (!didSubmit) {
      moveCaretToEnd(nextContent);
    }
  }, [moveCaretToEnd, resendRequest, submitContent]);

  const handleSubmit = () => {
    submitContent(content);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp') {
      if (e.nativeEvent.isComposing || isComposingRef.current || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        return;
      }
      const textarea = textareaRef.current;
      if (!textarea || sentHistory.length === 0) {
        return;
      }
      e.preventDefault();
      if (historyCursorRef.current === null) {
        historyDraftRef.current = content;
        historyCursorRef.current = sentHistory.length - 1;
      } else if (historyCursorRef.current > 0) {
        historyCursorRef.current -= 1;
      }
      const nextHistory = sentHistory[historyCursorRef.current] ?? sentHistory[sentHistory.length - 1] ?? '';
      setContent(nextHistory);
      moveCaretToEnd(nextHistory);
      return;
    }

    if (e.key === 'ArrowDown') {
      if (e.nativeEvent.isComposing || isComposingRef.current || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        return;
      }
      const textarea = textareaRef.current;
      if (!textarea || historyCursorRef.current === null) {
        return;
      }
      e.preventDefault();
      if (historyCursorRef.current < sentHistory.length - 1) {
        historyCursorRef.current += 1;
        const nextHistory = sentHistory[historyCursorRef.current] ?? '';
        setContent(nextHistory);
        moveCaretToEnd(nextHistory);
      } else {
        historyCursorRef.current = null;
        setContent(historyDraftRef.current);
        moveCaretToEnd(historyDraftRef.current);
      }
      return;
    }

    if (e.key !== 'Enter') return;
    if (e.nativeEvent.isComposing || isComposingRef.current) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = content.slice(0, start) + '\n' + content.slice(end);
      setContent(newContent);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1;
      }, 0);
      return;
    }
    e.preventDefault();
    handleSubmit();
  };

  return (
    <div className="border-t border-border bg-panel/95 px-4 py-3 backdrop-blur-sm md:px-6">
      <div className="w-full">
        <div
          ref={composerRef}
          className="w-full min-h-11 rounded-2xl border border-zinc-50 bg-paper px-3 py-3 transition-all dark:border-zinc-700/70 focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgba(228,87,46,0.1)]"
        >
          <div className={isSendOnNextLine ? 'flex flex-col gap-2' : 'flex items-center gap-2'}>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true; }}
              onCompositionEnd={() => { isComposingRef.current = false; }}
              placeholder={PLACEHOLDER_MESSAGES[placeholderIndex]}
              disabled={disabled}
              rows={1}
              data-testid="message-input-textarea"
              className={`block min-w-0 resize-none border-0 bg-transparent p-0 text-sm leading-relaxed text-ink placeholder:text-muted outline-none disabled:cursor-not-allowed disabled:opacity-60 ${
                isInputScrollable ? 'overflow-y-auto' : 'overflow-hidden'
              } ${
                isSendOnNextLine ? 'w-full' : 'w-full flex-1'
              }`}
            />
            <div className={isSendOnNextLine ? 'flex w-full justify-end' : 'flex shrink-0'}>
              <button
                onClick={handleSubmit}
                disabled={!canSend}
                className={`flex h-8 w-8 items-center justify-center rounded-md transition-all ${
                  canSend
                    ? 'webapp-gradient-bg text-white shadow-[0_2px_8px_rgba(228,87,46,0.25)] hover:brightness-105'
                    : 'border border-zinc-300 bg-transparent text-zinc-400 dark:border-zinc-600 dark:text-zinc-500'
                }`}
                title={sendDisabled ? 'Sending will be available when the session is ready' : 'Send'}
                aria-label="Send message"
              >
                <svg className="h-3.5 w-3.5 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M4 3l12 7-12 7V3z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';

const SEND_BUTTON_SIZE_PX = 32;
const COMPOSER_HORIZONTAL_PADDING_PX = 24;
const COMPOSER_GAP_PX = 8;
const SEND_BUTTON_SAFETY_GAP_PX = 12;
const INPUT_SCROLL_THRESHOLD_RATIO = 0.75;

const DRAFT_STORAGE_PREFIX = 'conductor-task-draft:';

interface MessageInputProps {
  taskId: string;
  onSend: (content: string) => void;
  disabled?: boolean;
  sendDisabled?: boolean;
}

const getDraftStorageKey = (taskId: string) => `${DRAFT_STORAGE_PREFIX}${taskId}`;

export function MessageInput({
  taskId,
  onSend,
  disabled,
  sendDisabled = false,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [isSendOnNextLine, setIsSendOnNextLine] = useState(false);
  const [isInputScrollable, setIsInputScrollable] = useState(false);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isComposingRef = useRef(false);
  const skipStoreEffectRef = useRef(true);

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

  const handleSubmit = () => {
    if (!content.trim() || disabled || sendDisabled) return;
    onSend(content.trim());
    setContent('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
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
              placeholder="Type a message..."
              disabled={disabled}
              rows={1}
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

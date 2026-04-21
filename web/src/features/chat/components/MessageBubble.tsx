'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message } from '@/shared/types';
import { MarkdownRenderer } from './MarkdownRenderer';

interface MessageBubbleProps {
  message: Message;
  onResend?: (content: string) => void;
  onInterrupt?: () => void;
  interruptEnabled?: boolean;
  interruptPending?: boolean;
}

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value < 1024) {
    return `${Math.max(0, Math.round(value || 0))} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

export function MessageBubble({
  message,
  onResend,
  onInterrupt,
  interruptEnabled = false,
  interruptPending = false,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle');
  const [isToolbarOpen, setIsToolbarOpen] = useState(false);
  const [isTimestampVisible, setIsTimestampVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastTouchEndAtRef = useRef(0);

  const prefersTapTimestamp = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia('(hover: none), (pointer: coarse)').matches;
  };

  const formatTime = (dateStr?: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleString(undefined, {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const copyMessage = async () => {
    try {
      let copied = false;
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(message.content);
        copied = true;
      }

      if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = message.content;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.top = '-1000px';
        textarea.style.left = '-1000px';
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand('copy');
        document.body.removeChild(textarea);
      }

      if (copied) {
        setCopyState('copied');
        setIsToolbarOpen(false);
        window.setTimeout(() => setCopyState('idle'), 1500);
      }
    } catch {
      setCopyState('idle');
    }
  };

  const resendMessage = () => {
    if (!message.content.trim()) {
      return;
    }
    onResend?.(message.content);
    setIsToolbarOpen(false);
  };

  const interruptTurn = () => {
    if (!interruptEnabled || interruptPending) {
      return;
    }
    onInterrupt?.();
    setIsToolbarOpen(false);
  };

  useEffect(() => {
    if (!isToolbarOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        (rootRef.current?.contains(target) || toolbarRef.current?.contains(target))
      ) {
        return;
      }
      setIsToolbarOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsToolbarOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isToolbarOpen]);

  useEffect(() => {
    setIsTimestampVisible(false);
  }, [message.id]);

  const isInteractiveTarget = (target: EventTarget | null) => (
    target instanceof HTMLElement && Boolean(target.closest('a, button, audio, video, summary'))
  );

  const actionButtonClassName = 'inline-flex h-9 w-9 items-center justify-center rounded-xl text-ink transition-colors hover:bg-border/35';
  const interruptActionLabel = interruptPending
    ? 'Interrupt pending'
    : interruptEnabled
      ? 'Interrupt current reply'
      : 'No reply to interrupt';

  const toolbarActions = (
    <>
      {onResend ? (
        <button
          type="button"
          aria-label="Resend message"
          title="Resend message"
          disabled={!message.content.trim()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            resendMessage();
          }}
          className={`${actionButtonClassName} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12a8 8 0 1 0 2.34-5.66" />
            <path d="M4 4v6h6" />
            <path d="M12 8v5l3 2" />
          </svg>
        </button>
      ) : null}
      <button
        type="button"
        aria-label={copyState === 'copied' ? 'Copied message' : 'Copy message'}
        title={copyState === 'copied' ? 'Copied message' : 'Copy message'}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void copyMessage();
        }}
        className={actionButtonClassName}
      >
        {copyState === 'copied' ? (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <rect x="2" y="2" width="13" height="13" rx="2" />
          </svg>
        )}
      </button>
      {onInterrupt ? (
        <button
          type="button"
          data-testid="message-bubble-interrupt-button"
          aria-label={interruptActionLabel}
          title={interruptActionLabel}
          disabled={!interruptEnabled || interruptPending}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            interruptTurn();
          }}
          className={`${actionButtonClassName} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3h8l5 5v8l-5 5H8l-5-5V8l5-5z" />
            <path d="M9 9l6 6" />
            <path d="M15 9l-6 6" />
          </svg>
        </button>
      ) : null}
    </>
  );

  return (
    <div className="w-full">
      <div className="w-full">
        <div
          ref={rootRef}
          className={`group/message relative overflow-visible rounded-2xl ${message.createdAt ? 'pt-2' : ''}`}
        >
          {message.createdAt ? (
            <span
              className={`pointer-events-none absolute left-4 -top-1 z-20 flex h-2 items-center text-[10px] leading-none text-muted transition-opacity ${
                isTimestampVisible ? 'opacity-100' : 'opacity-0 group-hover/message:opacity-100'
              }`}
            >
              {formatTime(message.createdAt)}
            </span>
          ) : null}
          <div
            className={`w-full rounded-2xl border px-4 py-3 ${
              isUser
                ? 'webapp-gradient-bg border-transparent text-white rounded-br-md shadow-[0_10px_24px_rgba(228,87,46,0.18)]'
                : 'bg-paper border-border rounded-bl-md shadow-sm'
            }`}
            role="button"
            tabIndex={0}
            aria-expanded={isToolbarOpen}
            onClick={(event) => {
              if (isInteractiveTarget(event.target)) {
                return;
              }
              if (prefersTapTimestamp()) {
                setIsTimestampVisible((current) => !current);
              }
            }}
            onDoubleClick={(event) => {
              if (isInteractiveTarget(event.target)) {
                return;
              }
              setIsToolbarOpen(true);
            }}
            onTouchEnd={(event) => {
              if (isInteractiveTarget(event.target)) {
                lastTouchEndAtRef.current = 0;
                return;
              }
              const now = Date.now();
              if (now - lastTouchEndAtRef.current <= 320) {
                lastTouchEndAtRef.current = 0;
                event.preventDefault();
                setIsToolbarOpen(true);
                return;
              }
              lastTouchEndAtRef.current = now;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setIsToolbarOpen(true);
              }
              if (event.key === 'Escape') {
                setIsToolbarOpen(false);
              }
            }}
          >
            {isUser ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-white">{message.content}</p>
            ) : (
              <div className="text-sm leading-relaxed">
                <MarkdownRenderer content={message.content} />
              </div>
            )}
            {message.attachments && message.attachments.length > 0 ? (
              <div className="mt-3 space-y-3">
                {message.attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className={`overflow-hidden rounded-xl border ${
                      isUser ? 'border-white/20 bg-white/10' : 'border-border bg-paper'
                    }`}
                  >
                    {attachment.kind === 'image' ? (
                      <a href={attachment.downloadUrl} target="_blank" rel="noreferrer" className="block">
                        <img
                          src={attachment.downloadUrl}
                          alt={attachment.name}
                          className="max-h-[28rem] w-full object-cover"
                        />
                      </a>
                    ) : null}
                    {attachment.kind === 'video' ? (
                      <video
                        controls
                        preload="metadata"
                        className="max-h-[28rem] w-full bg-black"
                        src={attachment.downloadUrl}
                      />
                    ) : null}
                    {attachment.kind === 'audio' ? (
                      <div className="p-3">
                        <audio controls className="w-full" src={attachment.downloadUrl} />
                      </div>
                    ) : null}
                    {attachment.kind === 'file' ? (
                      <a
                        href={attachment.downloadUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center justify-between gap-3 p-3 text-sm"
                      >
                        <span className={isUser ? 'text-white' : 'text-ink'}>{attachment.name}</span>
                        <span className={isUser ? 'text-white/70' : 'text-muted'}>{formatBytes(attachment.sizeBytes)}</span>
                      </a>
                    ) : null}
                    {attachment.kind !== 'file' ? (
                      <div className={`flex items-center justify-between gap-3 px-3 py-2 text-xs ${isUser ? 'text-white/70' : 'text-muted'}`}>
                        <span className="truncate">{attachment.name}</span>
                        <span>{formatBytes(attachment.sizeBytes)}</span>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

        </div>
      </div>

      {isToolbarOpen ? (
        <div className="fixed inset-0 z-50" onClick={() => setIsToolbarOpen(false)}>
          <div className="absolute inset-0 bg-black/20" />
          <div
            ref={toolbarRef}
            className="absolute inset-x-0 bottom-0 rounded-t-3xl border border-border bg-[var(--surface-panel)] p-4 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-border" />
            <div className="flex items-center justify-center">
              {toolbarActions}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

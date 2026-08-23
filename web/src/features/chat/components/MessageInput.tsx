'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Message } from '@/shared/types';
import { CatchphrasePopover } from '@/features/catchphrases/components/CatchphrasePopover';
import { useSwipeActions } from '@/shared/hooks/useSwipeActions';
import { useChatStore } from '../store';
import { compressImageIfNeeded } from '../image-compression';

const SEND_BUTTON_SIZE_PX = 32;
const COMPOSER_HORIZONTAL_PADDING_PX = 24;
const COMPOSER_GAP_PX = 8;
const SEND_BUTTON_SAFETY_GAP_PX = 12;
const INPUT_SCROLL_THRESHOLD_RATIO = 0.75;
const SWIPE_ACTION_WIDTH_PX = 52;
const SWIPE_ACTION_GAP_PX = 4; // matches the reveal panel's gap-1 and pr-1
const MAX_ATTACHMENTS = 20;
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const NATIVE_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const VIDEO_EXTENSIONS = new Set(['avi', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm']);

const DRAFT_STORAGE_PREFIX = 'conductor-task-draft:';
const MAX_HISTORY_ITEMS = 200;
const PLACEHOLDER_ROTATION_MS = 3200;
const PLACEHOLDER_MESSAGES = [
  'Type a message...',
  'Ask Conductor what to do next…',
  'Paste a concrete task to get started…',
  'Tip: use ↑ / ↓ to browse recent prompts',
] as const;

interface MessageInputProps {
  taskId: string;
  onSend: (content: string, files?: File[]) => Promise<void> | void;
  onSchedule?: (draft: string) => void;
  onInsert?: (content: string) => void;
  onInterrupt?: () => void;
  disabled?: boolean;
  sendDisabled?: boolean;
  interruptEnabled?: boolean;
  interruptPending?: boolean;
  insertEnabled?: boolean;
  insertPending?: boolean;
  autoFocus?: boolean;
}

// How long (ms) a single send-button click waits for a possible second click
// before committing to a normal send. Only used while an insert is actually
// possible, so ordinary sending keeps zero latency the rest of the time.
const SEND_BUTTON_DOUBLE_CLICK_MS = 250;

export interface MessageInputHandle {
  resend: (content: string) => void;
  /**
   * Put text back into the composer WITHOUT sending — used to recover a draft
   * after a send ultimately failed, so the user never loses what they typed.
   * No-op when the user has already started a new draft (don't clobber it).
   */
  restoreDraft: (content: string) => void;
}

const getDraftStorageKey = (taskId: string) => `${DRAFT_STORAGE_PREFIX}${taskId}`;

const readStoredDraft = (taskId: string) => {
  if (typeof window === 'undefined') {
    return '';
  }

  try {
    return window.sessionStorage.getItem(getDraftStorageKey(taskId)) ?? '';
  } catch {
    return '';
  }
};

const persistDraft = (taskId: string, nextContent: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const key = getDraftStorageKey(taskId);
    if (!nextContent) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, nextContent);
  } catch {
    // ignore storage errors
  }
};

interface ComposerLayoutState {
  isInputScrollable: boolean;
  hasExplicitNewLine: boolean;
  isWrappedToMultipleLines: boolean;
  isNearSendButton: boolean;
}

const INITIAL_LAYOUT_STATE: ComposerLayoutState = {
  isInputScrollable: false,
  hasExplicitNewLine: false,
  isWrappedToMultipleLines: false,
  isNearSendButton: false,
};

// Derive the "previous prompt" history for ArrowUp/ArrowDown from the chat
// store's message log. This walks the persisted chat history from newest to
// oldest, keeping only user-authored messages, deduplicating by content so
// repeated prompts collapse into a single history entry, then reverses so
// that the last item is the most-recent prompt (matching the existing
// cursor logic which starts at `length - 1`).
//
// Because it reads from the shared chat store rather than an input-local
// session buffer, prompts sent by the same task from another signed-in web
// client (delivered via the REST page load or a websocket push) are also
// reachable via ArrowUp.
const deriveSentHistoryFromMessages = (messages: Message[]): string[] => {
  const seen = new Set<string>();
  const reversed: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'user') {
      continue;
    }
    const trimmed = (message.content ?? '').trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    reversed.push(trimmed);
    if (reversed.length >= MAX_HISTORY_ITEMS) {
      break;
    }
  }
  reversed.reverse();
  return reversed;
};

const MessageInputInner = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInputInner({
  taskId,
  onSend,
  onSchedule,
  onInsert,
  onInterrupt,
  disabled,
  sendDisabled = false,
  interruptEnabled = false,
  interruptPending = false,
  insertEnabled = false,
  insertPending = false,
  autoFocus = false,
}: MessageInputProps, ref) {
  const [content, setContent] = useState(() => readStoredDraft(taskId));
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [fileError, setFileError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [layoutState, setLayoutState] = useState(INITIAL_LAYOUT_STATE);
  const [isCatchphraseOpen, setIsCatchphraseOpen] = useState(false);
  const swipeActionCount = onSchedule ? 2 : 1;
  // Slide exactly as far as the reveal panel is wide: N buttons, the gaps
  // between them, and the panel's trailing padding. Anything less leaves a
  // sliver of the panel tucked under the composer's edge.
  const swipeMenuWidth = swipeActionCount * SWIPE_ACTION_WIDTH_PX + swipeActionCount * SWIPE_ACTION_GAP_PX;
  const composerSwipe = useSwipeActions({ maxOffset: swipeMenuWidth });
  const { closeActions: closeComposerActions } = composerSwipe;
  const firstSwipeActionRef = useRef<HTMLButtonElement>(null);
  const taskMessages = useChatStore((state) => state.messagesByTask[taskId]);
  const sentHistory = useMemo(
    () => deriveSentHistoryFromMessages(taskMessages ?? []),
    [taskMessages],
  );
  const [placeholderIndex, setPlaceholderIndex] = useState(0);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const isComposingRef = useRef(false);
  // Track which history entry is currently displayed by content rather than
  // by numeric index. `sentHistory` is derived from `messagesByTask[taskId]`,
  // so it can grow (websocket push of another user prompt) or shift
  // (pagination prepend of older messages) while the user is mid-browse; a
  // content cursor lets each keypress re-anchor to the same prompt even if
  // its position in the list changed since the previous keypress.
  const historyCursorRef = useRef<string | null>(null);
  const historyDraftRef = useRef('');
  // Pending single-click timer for the send button. While an insert is
  // possible, a single click is deferred briefly so a second click (double
  // click) can be recognized as "insert" instead of "send".
  const sendClickTimerRef = useRef<number | null>(null);

  const updateContent = useCallback((nextContent: string) => {
    setContent(nextContent);
    persistDraft(taskId, nextContent);
  }, [taskId]);

  const isSendOnNextLine = useMemo(() => (
    Boolean(content) && (
      layoutState.hasExplicitNewLine
      || layoutState.isWrappedToMultipleLines
      || layoutState.isNearSendButton
    )
  ), [
    content,
    layoutState.hasExplicitNewLine,
    layoutState.isNearSendButton,
    layoutState.isWrappedToMultipleLines,
  ]);
  const isInputScrollable = layoutState.isInputScrollable;

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
  }, [autoFocus, disabled]);

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

    const hasExplicitNewLine = content.includes('\n');
    const isWrappedToMultipleLines = Boolean(content) && textarea.scrollHeight > lineHeight * 1.5;

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

    const nextLayoutState: ComposerLayoutState = {
      isInputScrollable: shouldEnableScroll,
      hasExplicitNewLine,
      isWrappedToMultipleLines,
      isNearSendButton,
    };
    setLayoutState((previous) => (
      previous.isInputScrollable === nextLayoutState.isInputScrollable
      && previous.hasExplicitNewLine === nextLayoutState.hasExplicitNewLine
      && previous.isWrappedToMultipleLines === nextLayoutState.isWrappedToMultipleLines
      && previous.isNearSendButton === nextLayoutState.isNearSendButton
        ? previous
        : nextLayoutState
    ));
  }, [content]);

  const canSend = Boolean(content.trim() || selectedFiles.length) && !disabled && !sendDisabled && !isSubmitting;

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
    if ((!nextContent.trim() && selectedFiles.length === 0) || disabled || sendDisabled || isSubmitting) return false;
    const trimmedContent = nextContent.trim();
    const filesToSend = [...selectedFiles];
    setIsSubmitting(true);
    setFileError('');
    let sendResult: void | Promise<void>;
    try {
      sendResult = filesToSend.length ? onSend(trimmedContent, filesToSend) : onSend(trimmedContent);
    } catch {
      setFileError(filesToSend.length
        ? 'Upload or send failed. Your files are still selected; please retry.'
        : 'Send failed. Your message is still here; please retry.');
      setIsSubmitting(false);
      return true;
    }
    if (!sendResult || typeof (sendResult as Promise<void>).then !== 'function') {
      updateContent('');
      setSelectedFiles([]);
      setIsSubmitting(false);
    } else {
      void sendResult
      .then(() => {
        updateContent('');
        setSelectedFiles([]);
        setFileError('');
      })
      .catch(() => setFileError(filesToSend.length
        ? 'Upload or send failed. Your files are still selected; please retry.'
        : 'Send failed. Your message is still here; please retry.'))
      .finally(() => setIsSubmitting(false));
    }
    // The prompt will show up in the ArrowUp history as soon as it lands in
    // the chat store (either via the optimistic insert in `sendMessage` or
    // when the server echoes it back), so no local bookkeeping is needed
    // here beyond resetting the browsing cursor.
    historyCursorRef.current = null;
    historyDraftRef.current = '';
    return true;
  }, [disabled, isSubmitting, onSend, selectedFiles, sendDisabled, updateContent]);

  const handleResend = useCallback((nextContent: string) => {
    historyCursorRef.current = null;
    historyDraftRef.current = '';

    const didSubmit = submitContent(nextContent);
    if (!didSubmit) {
      updateContent(nextContent);
      moveCaretToEnd(nextContent);
    }
  }, [moveCaretToEnd, submitContent, updateContent]);

  useImperativeHandle(ref, () => ({
    resend: handleResend,
    restoreDraft: (nextContent: string) => {
      if (content.trim()) {
        return;
      }
      updateContent(nextContent);
      moveCaretToEnd(nextContent);
    },
  }), [handleResend, content, moveCaretToEnd, updateContent]);

  const handleSubmit = () => {
    submitContent(content);
  };

  // Insert the composer text into the in-flight turn (interrupt + run next).
  // Falls back to a normal send when insert isn't available so the action is
  // never silently lost.
  const submitInsert = useCallback((nextContent: string) => {
    const trimmed = nextContent.trim();
    if (!trimmed || disabled || sendDisabled) return false;
    if (selectedFiles.length > 0 || !insertEnabled || !onInsert) {
      return submitContent(nextContent);
    }
    onInsert(trimmed);
    historyCursorRef.current = null;
    historyDraftRef.current = '';
    updateContent('');
    return true;
  }, [disabled, insertEnabled, onInsert, selectedFiles.length, sendDisabled, submitContent, updateContent]);

  const clearSendClickTimer = useCallback(() => {
    if (sendClickTimerRef.current !== null) {
      window.clearTimeout(sendClickTimerRef.current);
      sendClickTimerRef.current = null;
    }
  }, []);

  // Send button: single click / Enter => normal send (queues after the current
  // turn); double click => insert into the current turn. We only disambiguate
  // single vs double when an insert is actually possible, so normal sending
  // keeps zero latency the rest of the time. Enter always sends immediately
  // (handled in handleKeyDown), preserving the original semantics.
  const handleSendButtonClick = () => {
    if (!insertEnabled) {
      // Cancel any deferred send still pending from a prior click so that a
      // second click landing here (insert became unavailable mid double-click)
      // can't fire the queued send on top of this one.
      clearSendClickTimer();
      handleSubmit();
      return;
    }
    if (sendClickTimerRef.current !== null) {
      // Second click within the window => insert.
      clearSendClickTimer();
      submitInsert(content);
      return;
    }
    const pendingContent = content;
    sendClickTimerRef.current = window.setTimeout(() => {
      sendClickTimerRef.current = null;
      submitContent(pendingContent);
    }, SEND_BUTTON_DOUBLE_CLICK_MS);
  };

  useEffect(() => clearSendClickTimer, [clearSendClickTimer]);

  // RFC 0032: empty-input double-click is the only trigger for the
  // catchphrase popover. The handler returns early (no preventDefault) on a
  // non-empty textarea so the browser's native double-click-to-select-word
  // remains fully intact. IME composition is also skipped so half-finished
  // pinyin/IME input doesn't accidentally "look empty".
  const handleTextareaDoubleClick = useCallback(() => {
    if (isComposingRef.current) return;
    if (content.trim() !== '') return;
    setIsCatchphraseOpen(true);
  }, [content]);

  // Auto-close the popover the moment the textarea becomes non-empty so it
  // never obscures the user's typing.
  useEffect(() => {
    if (isCatchphraseOpen && content.trim() !== '') {
      setIsCatchphraseOpen(false);
    }
  }, [isCatchphraseOpen, content]);

  const handleCatchphrasePick = useCallback((catchphrase: { text: string }) => {
    setIsCatchphraseOpen(false);
    updateContent(catchphrase.text);
    moveCaretToEnd(catchphrase.text);
  }, [moveCaretToEnd, updateContent]);

  const handleCatchphraseSend = useCallback((catchphrase: { text: string }) => {
    setIsCatchphraseOpen(false);
    const didSubmit = submitContent(catchphrase.text);
    if (!didSubmit) {
      // Sending was blocked (disabled or sendDisabled); fall back to fill so
      // the user can retry once the composer is enabled.
      updateContent(catchphrase.text);
      moveCaretToEnd(catchphrase.text);
    }
  }, [moveCaretToEnd, submitContent, updateContent]);

  const triggerInterrupt = useCallback(() => {
    if (!interruptEnabled || interruptPending) {
      return;
    }
    onInterrupt?.();
  }, [interruptEnabled, interruptPending, onInterrupt]);

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
      let nextHistory: string;
      if (historyCursorRef.current === null) {
        // Starting a new browsing session — stash the current draft and jump
        // to the most recent prompt.
        historyDraftRef.current = content;
        nextHistory = sentHistory[sentHistory.length - 1];
      } else {
        // Re-locate the previously shown prompt against the *current*
        // `sentHistory` (it may have grown or shifted since the last
        // keypress) and step one entry older. `lastIndexOf` prefers the
        // newest occurrence if duplicates appeared transiently.
        const currentIndex = sentHistory.lastIndexOf(historyCursorRef.current);
        if (currentIndex === -1) {
          // The anchored prompt is no longer present (e.g. history was
          // cleared). Re-anchor to the newest entry rather than getting
          // stuck.
          nextHistory = sentHistory[sentHistory.length - 1];
        } else if (currentIndex > 0) {
          nextHistory = sentHistory[currentIndex - 1];
        } else {
          // Already at the oldest entry — stay put.
          nextHistory = sentHistory[0];
        }
      }
      historyCursorRef.current = nextHistory;
      updateContent(nextHistory);
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
      const currentIndex = sentHistory.lastIndexOf(historyCursorRef.current);
      if (currentIndex === -1 || currentIndex >= sentHistory.length - 1) {
        // Either the anchored prompt is gone, or we're already at/past the
        // newest — exit browsing mode and restore the stashed draft.
        historyCursorRef.current = null;
        updateContent(historyDraftRef.current);
        moveCaretToEnd(historyDraftRef.current);
        return;
      }
      const nextHistory = sentHistory[currentIndex + 1];
      historyCursorRef.current = nextHistory;
      updateContent(nextHistory);
      moveCaretToEnd(nextHistory);
      return;
    }

    if (e.key === 'Escape') {
      if (e.nativeEvent.isComposing || isComposingRef.current) {
        return;
      }
      if (content.trim()) {
        return;
      }
      if (!interruptEnabled || interruptPending) {
        return;
      }
      e.preventDefault();
      triggerInterrupt();
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
      updateContent(newContent);
      setTimeout(() => {
        textarea.selectionStart = textarea.selectionEnd = start + 1;
      }, 0);
      return;
    }
    e.preventDefault();
    handleSubmit();
  };

  const handleFilesSelected = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    const invalidVideo = picked.find((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      return file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension);
    });
    if (invalidVideo) {
      setFileError('Video attachments are not supported.');
      return;
    }
    // Shrink oversized photos in the browser before they enter the upload
    // pipeline, so previews, dedup and every network hop see the smaller file.
    const incoming = await Promise.all(picked.map((file) => compressImageIfNeeded(file)));
    const oversized = incoming.find((file) => file.size > MAX_ATTACHMENT_BYTES);
    const oversizedImage = incoming.find((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      return (NATIVE_IMAGE_TYPES.has(file.type.toLowerCase()) || NATIVE_IMAGE_EXTENSIONS.has(extension))
        && file.size > MAX_IMAGE_BYTES;
    });
    if (oversizedImage) {
      setFileError(`${oversizedImage.name} exceeds the 20 MB image limit.`);
      return;
    }
    if (oversized) {
      setFileError(`${oversized.name} exceeds the 100 MB limit.`);
      return;
    }
    setSelectedFiles((current) => {
      const next = [...current];
      for (const file of incoming) {
        if (next.length >= MAX_ATTACHMENTS) break;
        if (!next.some((entry) => entry.name === file.name && entry.size === file.size && entry.lastModified === file.lastModified)) {
          next.push(file);
        }
      }
      return next;
    });
    setFileError(incoming.length + selectedFiles.length > MAX_ATTACHMENTS ? 'A message can contain at most 20 files.' : '');
  }, [selectedFiles.length]);

  const attachDisabled = disabled || sendDisabled || isSubmitting || selectedFiles.length >= MAX_ATTACHMENTS;
  const openAttachPicker = useCallback(() => {
    closeComposerActions();
    fileInputRef.current?.click();
  }, [closeComposerActions]);
  const scheduleDraft = useCallback(() => {
    closeComposerActions();
    onSchedule?.(content);
  }, [closeComposerActions, onSchedule, content]);
  const toggleComposerActions = useCallback(() => {
    if (composerSwipe.isOpen) {
      composerSwipe.closeActions();
    } else {
      composerSwipe.openActions();
      // Land keyboard focus on the revealed menu so it is operable without a
      // pointer; a touch swipe never reaches here so focus is not stolen there.
      requestAnimationFrame(() => firstSwipeActionRef.current?.focus());
    }
  }, [composerSwipe]);

  return (
    <div className="relative border-t border-border bg-panel/95 px-4 py-3 backdrop-blur-sm md:px-6">
      <CatchphrasePopover
        open={isCatchphraseOpen}
        onClose={() => setIsCatchphraseOpen(false)}
        onPick={handleCatchphrasePick}
        onSend={handleCatchphraseSend}
      />
      <div className="relative w-full overflow-hidden rounded-2xl">
        {/* Left-swipe menu: revealed behind the composer on its right edge. */}
        <div
          className="absolute inset-y-0 right-0 z-0 flex items-center gap-1 pr-1"
          data-testid="message-input-swipe-actions"
          aria-hidden={!composerSwipe.isOpen}
        >
          <button
            ref={firstSwipeActionRef}
            type="button"
            aria-label="Attach files"
            title="Attach images or context files"
            data-testid="message-input-attach-button"
            tabIndex={composerSwipe.isOpen ? 0 : -1}
            disabled={attachDisabled}
            onClick={openAttachPicker}
            style={{ width: SWIPE_ACTION_WIDTH_PX }}
            className="flex h-10 flex-col items-center justify-center gap-0.5 rounded-xl text-muted transition-colors hover:bg-border/50 hover:text-ink disabled:opacity-40"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4" aria-hidden="true">
              <path d="m21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.6-9.6a4 4 0 0 1 5.7 5.7l-9.6 9.6a2 2 0 0 1-2.8-2.8l8.9-8.9" />
            </svg>
            <span className="text-[10px] leading-none">Attach</span>
          </button>
          {onSchedule ? (
            <button
              type="button"
              aria-label="Schedule this message"
              title="Schedule this message"
              data-testid="message-input-schedule-button"
              tabIndex={composerSwipe.isOpen ? 0 : -1}
              onClick={scheduleDraft}
              style={{ width: SWIPE_ACTION_WIDTH_PX }}
              className="flex h-10 flex-col items-center justify-center gap-0.5 rounded-xl text-muted transition-colors hover:bg-border/50 hover:text-ink"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
                <path d="M17.5 3.5l3 3" />
              </svg>
              <span className="text-[10px] leading-none">Schedule</span>
            </button>
          ) : null}
        </div>
        <div
          ref={composerRef}
          data-testid="message-input-composer"
          style={composerSwipe.panelStyle}
          onPointerDown={(event) => { if (event.pointerType !== 'mouse') composerSwipe.onPointerDown(event); }}
          onPointerMove={(event) => { if (event.pointerType !== 'mouse') composerSwipe.onPointerMove(event); }}
          onPointerUp={composerSwipe.onPointerUp}
          onPointerCancel={composerSwipe.onPointerCancel}
          // Opaque surface so the swipe-revealed actions stay fully hidden until
          // the composer slides aside (bg-paper is not a generated utility here).
          className="relative z-10 w-full min-h-11 rounded-2xl border border-zinc-50 bg-[var(--paper)] p-3 transition-all dark:border-zinc-700/70 focus-within:border-accent focus-within:shadow-[0_0_0_4px_rgba(228,87,46,0.1)]"
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="message-input-file-picker"
            onChange={handleFilesSelected}
            disabled={disabled || sendDisabled || isSubmitting}
          />
          {selectedFiles.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5" data-testid="message-input-files">
              {selectedFiles.map((file) => (
                <span key={`${file.name}-${file.size}-${file.lastModified}`} className="inline-flex max-w-full items-center gap-1 rounded-md bg-border/50 px-2 py-1 text-xs text-ink">
                  <span className="max-w-48 truncate">{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    className="text-muted hover:text-ink"
                    onClick={() => setSelectedFiles((current) => current.filter((entry) => entry !== file))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {fileError ? <p className="mb-2 text-xs text-red-600">{fileError}</p> : null}
          <div className={isSendOnNextLine ? 'flex flex-col gap-2' : 'flex items-center gap-2'}>
            <button
              type="button"
              aria-label={composerSwipe.isOpen ? 'Hide actions' : 'Show actions'}
              title="Attach files or schedule (swipe left)"
              data-testid="message-input-actions-toggle"
              aria-expanded={composerSwipe.isOpen}
              onClick={toggleComposerActions}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-border/50 hover:text-ink"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`size-4 transition-transform ${composerSwipe.isOpen ? 'rotate-180' : ''}`} aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </button>
            <textarea
              ref={textareaRef}
              aria-label="Message input"
              value={content}
              onChange={(e) => updateContent(e.target.value)}
              onFocus={() => { if (composerSwipe.isOpen) closeComposerActions(); }}
              onKeyDown={handleKeyDown}
              onDoubleClick={handleTextareaDoubleClick}
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
              <button type="button"
                onClick={handleSendButtonClick}
                disabled={!canSend}
                data-testid="message-input-send-button"
                className={`flex h-8 w-8 items-center justify-center rounded-md transition-all ${
                  canSend
                    ? 'webapp-gradient-bg text-white shadow-[0_2px_8px_rgba(228,87,46,0.25)] hover:brightness-105'
                    : 'border border-zinc-300 bg-transparent text-zinc-400 dark:border-zinc-600 dark:text-zinc-500'
                } ${insertEnabled ? 'ring-2 ring-accent/50 ring-offset-1 ring-offset-paper' : ''}`}
                title={
                  sendDisabled
                    ? 'Sending will be available when the session is ready'
                    : insertEnabled
                      ? 'Click to send · double-click to insert into the current reply'
                      : 'Send'
                }
                aria-label={insertEnabled ? 'Send message (double-click to insert into the current reply)' : 'Send message'}
              >
                <svg className="size-3.5 translate-x-px" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M4 3l12 7-12 7V3z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

MessageInputInner.displayName = 'MessageInputInner';

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(props, ref) {
  return <MessageInputInner key={props.taskId} ref={ref} {...props} />;
});

MessageInput.displayName = 'MessageInput';

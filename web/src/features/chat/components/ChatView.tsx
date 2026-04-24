'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { useRuntimeStore } from '@/features/realtime';
import { useTasksStore } from '@/features/tasks';
import { useWebSocketStore } from '@/features/realtime';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineNotice } from '@/components/common/InlineNotice';
import { getApiClient } from '@/shared/api/client';

interface ChatViewProps {
  taskId: string;
  autoFocusComposer?: boolean;
}

const SCROLL_STORAGE_PREFIX = 'conductor-task-scroll:';
const SCROLL_BOTTOM_THRESHOLD_PX = 40;
const SCROLL_TOP_LOAD_THRESHOLD_PX = 24;
// Minimum overflow distance (scrollHeight - clientHeight) before the floating
// "jump to latest" button becomes useful. Kept distinct from the near-bottom
// threshold above because these are two unrelated decisions that only happen
// to share a numeric value today.
const SCROLL_TO_BOTTOM_BUTTON_MIN_OVERFLOW_PX = 40;
const INTERRUPT_CONFIRMATION_TIMEOUT_MS = 5000;
const COMPOSER_FEEDBACK_AUTO_DISMISS_MS = 5000;

interface StoredScrollState {
  scrollTop: number;
  stickToBottom: boolean;
}

const getScrollStorageKey = (taskId: string) => `${SCROLL_STORAGE_PREFIX}${taskId}`;

const getMaxScrollTop = (element: HTMLDivElement) => Math.max(0, element.scrollHeight - element.clientHeight);

const clampScrollTop = (element: HTMLDivElement, scrollTop: number) => (
  Math.min(Math.max(scrollTop, 0), getMaxScrollTop(element))
);

const isNearBottom = (element: HTMLDivElement) => (
  getMaxScrollTop(element) - element.scrollTop <= SCROLL_BOTTOM_THRESHOLD_PX
);

const readStoredScrollState = (taskId: string): StoredScrollState | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.sessionStorage.getItem(getScrollStorageKey(taskId));
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Number.isFinite(parsed.scrollTop) &&
      typeof parsed.stickToBottom === 'boolean'
    ) {
      return {
        scrollTop: Math.max(0, parsed.scrollTop),
        stickToBottom: parsed.stickToBottom,
      };
    }

    if (Number.isFinite(parsed)) {
      return {
        scrollTop: Math.max(0, parsed),
        stickToBottom: false,
      };
    }
  } catch {
    // ignore storage errors
  }

  return null;
};

const writeStoredScrollState = (taskId: string, state: StoredScrollState) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.sessionStorage.setItem(getScrollStorageKey(taskId), JSON.stringify(state));
  } catch {
    // ignore storage errors
  }
};

const getAiRuntimeStatusText = (runtime?: {
  statusLine?: string;
  statusDoneLine?: string;
} | null) => {
  if (!runtime) {
    return null;
  }

  return runtime.statusLine?.trim() || runtime.statusDoneLine?.trim() || null;
};

const getMessageReplyTarget = (message: { metadata?: Record<string, unknown> | null } | null | undefined) => {
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return '';
  }
  if (typeof metadata.reply_to === 'string' && metadata.reply_to.trim()) {
    return metadata.reply_to.trim();
  }
  if (typeof metadata.replyTo === 'string' && metadata.replyTo.trim()) {
    return metadata.replyTo.trim();
  }
  return '';
};

const isInterruptConfirmationMessage = (
  message: { metadata?: Record<string, unknown> | null } | null | undefined,
  replyTo: string,
) => {
  if (!replyTo) {
    return false;
  }
  const metadata = message?.metadata;
  if (!metadata || typeof metadata !== 'object' || metadata.interrupted !== true) {
    return false;
  }
  return getMessageReplyTarget(message) === replyTo;
};

export function ChatView({ taskId, autoFocusComposer = false }: ChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const interruptTimeoutRef = useRef<number | null>(null);
  const interruptPendingRef = useRef(false);
  const resendRequestIdRef = useRef(0);
  const previousMessageCountRef = useRef(0);
  const pendingRestoreScrollStateRef = useRef<StoredScrollState | null>(null);
  const pendingPrependAnchorRef = useRef<{ previousScrollHeight: number; previousScrollTop: number } | null>(null);
  const autoLoadUntilFilledRef = useRef(false);
  const shouldRestoreScrollRef = useRef(true);
  const shouldStickToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const previousWebSocketStatusRef = useRef<'connected' | 'connecting' | 'disconnected' | null>(null);
  const { messagesByTask, historyStateByTask, loadingTasks, fetchMessages, sendMessage } = useChatStore();
  const runtime = useRuntimeStore((state) => state.byTask[taskId]);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const tasks = useTasksStore((state) => state.tasks);
  const restartTask = useTasksStore((state) => state.restartTask);
  const websocketStatus = useWebSocketStore((state) => state.status);
  const task = tasks.find((t) => t.id === taskId);
  const isTaskRunning = task?.status === 'running';
  const [composerFeedback, setComposerFeedback] = useState<{
    code?: 'task_not_ready' | 'restarting';
    variant: 'info' | 'warning' | 'error';
    message: string;
  } | null>(null);
  const [interruptPending, setInterruptPending] = useState(false);
  const [interruptTargetReplyTo, setInterruptTargetReplyTo] = useState<string | null>(null);
  const [pendingInterruptReplyTo, setPendingInterruptReplyTo] = useState<string | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [resendRequest, setResendRequest] = useState<{
    id: number;
    content: string;
  } | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const messages = messagesByTask[taskId] || [];
  const historyState = historyStateByTask[taskId];
  const isLoading = loadingTasks.has(taskId);
  const hasMoreBefore = historyState?.hasMoreBefore ?? false;
  const oldestMessageId = historyState?.oldestMessageId ?? null;
  const aiRuntimeStatusText = getAiRuntimeStatusText(runtime);
  const runtimeReplyInProgress = Boolean(runtime?.replyInProgress);
  const runtimeReplyTo =
    runtimeReplyInProgress && typeof runtime?.replyTo === 'string' ? runtime.replyTo.trim() : '';
  const activeInterruptReplyTo = runtimeReplyTo || interruptTargetReplyTo || '';
  const restartEnabled = Boolean(
    task &&
    (task.taskType ?? 'ai_task') === 'ai_task' &&
    task.status === 'running' &&
    !restartPending &&
    !interruptPending,
  );
  const interruptEnabled = Boolean(isTaskRunning && activeInterruptReplyTo && !restartPending);
  const showEmptyStateRestart = Boolean(
    task &&
    (task.taskType ?? 'ai_task') === 'ai_task' &&
    task.status === 'running',
  );

  const clearInterruptTimeout = useCallback(() => {
    if (interruptTimeoutRef.current === null) {
      return;
    }
    window.clearTimeout(interruptTimeoutRef.current);
    interruptTimeoutRef.current = null;
  }, []);

  const persistScrollPosition = (scrollTop?: number) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const nextScrollTop = typeof scrollTop === 'number'
      ? clampScrollTop(container, scrollTop)
      : clampScrollTop(container, container.scrollTop);
    const stickToBottom = isNearBottom(container);
    const canScroll = getMaxScrollTop(container) > SCROLL_TO_BOTTOM_BUTTON_MIN_OVERFLOW_PX;

    shouldStickToBottomRef.current = stickToBottom;
    setShowScrollToBottom(canScroll && !stickToBottom);
    writeStoredScrollState(taskId, {
      scrollTop: nextScrollTop,
      stickToBottom,
    });
  };

  const scrollToBottom = () => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const nextScrollTop = getMaxScrollTop(container);
    container.scrollTop = nextScrollTop;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    writeStoredScrollState(taskId, {
      scrollTop: nextScrollTop,
      stickToBottom: true,
    });
  };

  const loadOlderMessages = async (options?: { continueUntilFilled?: boolean }) => {
    if (!oldestMessageId || isLoading) {
      return;
    }
    if (options?.continueUntilFilled) {
      autoLoadUntilFilledRef.current = true;
    }
    const container = scrollContainerRef.current;
    if (container) {
      pendingPrependAnchorRef.current = {
        previousScrollHeight: container.scrollHeight,
        previousScrollTop: container.scrollTop,
      };
    }
    await fetchMessages(taskId, { beforeId: oldestMessageId });
  };

  const maybeContinueAutoLoadUntilFilled = () => {
    const container = scrollContainerRef.current;
    if (!autoLoadUntilFilledRef.current || !container || isLoading) {
      return;
    }

    if (!hasMoreBefore || !oldestMessageId) {
      autoLoadUntilFilledRef.current = false;
      return;
    }

    if (container.scrollHeight > container.clientHeight + SCROLL_TOP_LOAD_THRESHOLD_PX) {
      autoLoadUntilFilledRef.current = false;
      return;
    }

    void loadOlderMessages({ continueUntilFilled: true });
  };

  useEffect(() => {
    fetchMessages(taskId);
  }, [taskId, fetchMessages]);

  useEffect(() => (
    () => {
      clearInterruptTimeout();
    }
  ), [clearInterruptTimeout]);

  useEffect(() => {
    interruptPendingRef.current = interruptPending;
  }, [interruptPending]);

  useEffect(() => {
    const previousStatus = previousWebSocketStatusRef.current;
    previousWebSocketStatusRef.current = websocketStatus;

    if (
      previousStatus &&
      previousStatus !== 'connected' &&
      websocketStatus === 'connected'
    ) {
      void fetchMessages(taskId, { force: true });
    }
  }, [fetchMessages, taskId, websocketStatus]);

  useLayoutEffect(() => {
    pendingRestoreScrollStateRef.current = readStoredScrollState(taskId);
    autoLoadUntilFilledRef.current = false;
    shouldRestoreScrollRef.current = true;
    forceScrollToBottomRef.current = false;
    previousMessageCountRef.current = messages.length;
    setShowScrollToBottom(false);
  }, [taskId]);

  useEffect(() => (
    () => {
      persistScrollPosition();
    }
  ), [taskId]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    if (pendingPrependAnchorRef.current) {
      const { previousScrollHeight, previousScrollTop } = pendingPrependAnchorRef.current;
      const delta = container.scrollHeight - previousScrollHeight;
      const nextScrollTop = clampScrollTop(container, previousScrollTop + delta);
      container.scrollTop = nextScrollTop;
      persistScrollPosition(nextScrollTop);
      pendingPrependAnchorRef.current = null;
      previousMessageCountRef.current = messages.length;
      maybeContinueAutoLoadUntilFilled();
      return;
    }

    if (shouldRestoreScrollRef.current) {
      if (isLoading && messages.length === 0) {
        return;
      }

      const storedScrollState = pendingRestoreScrollStateRef.current;
      if (storedScrollState?.stickToBottom) {
        scrollToBottom();
      } else if (storedScrollState) {
        const nextScrollTop = clampScrollTop(container, storedScrollState.scrollTop);
        container.scrollTop = nextScrollTop;
        persistScrollPosition(nextScrollTop);
      } else {
        scrollToBottom();
      }

      shouldRestoreScrollRef.current = false;
      pendingRestoreScrollStateRef.current = null;
      previousMessageCountRef.current = messages.length;
      maybeContinueAutoLoadUntilFilled();
      return;
    }

    const previousMessageCount = previousMessageCountRef.current;
    if (
      messages.length > previousMessageCount &&
      (forceScrollToBottomRef.current || shouldStickToBottomRef.current)
    ) {
      scrollToBottom();
    }

    forceScrollToBottomRef.current = false;
    previousMessageCountRef.current = messages.length;
    maybeContinueAutoLoadUntilFilled();
  }, [isLoading, messages.length, taskId]);

  useEffect(() => {
    clearInterruptTimeout();
    setComposerFeedback(null);
    setInterruptPending(false);
    setInterruptTargetReplyTo(null);
    setPendingInterruptReplyTo(null);
    setRestartPending(false);
  }, [clearInterruptTimeout, taskId]);

  useEffect(() => {
    if (isTaskRunning && composerFeedback?.code === 'task_not_ready') {
      setComposerFeedback(null);
    }
  }, [composerFeedback?.code, isTaskRunning]);

  useEffect(() => {
    if (!composerFeedback) {
      return;
    }
    // Skip progress-style notices (e.g. "Restarting the current AI session…")
    // that must persist until the underlying operation completes. Those notices
    // are cleared explicitly in their own finally/catch paths.
    if (composerFeedback.code === 'restarting') {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      setComposerFeedback(null);
    }, COMPOSER_FEEDBACK_AUTO_DISMISS_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [composerFeedback]);

  useEffect(() => {
    if (runtimeReplyTo) {
      setInterruptTargetReplyTo(runtimeReplyTo);
      return;
    }
    if (!runtimeReplyInProgress) {
      setInterruptTargetReplyTo(null);
    }
  }, [runtimeReplyInProgress, runtimeReplyTo]);

  useEffect(() => {
    if (!runtimeReplyInProgress) {
      clearInterruptTimeout();
      setInterruptPending(false);
      setPendingInterruptReplyTo(null);
    }
  }, [clearInterruptTimeout, runtimeReplyInProgress]);

  useEffect(() => {
    if (!interruptPending || !pendingInterruptReplyTo) {
      return;
    }
    if (!messages.some((message) => isInterruptConfirmationMessage(message, pendingInterruptReplyTo))) {
      return;
    }
    clearInterruptTimeout();
    setInterruptPending(false);
    setPendingInterruptReplyTo(null);
    setInterruptTargetReplyTo((current) => (current === pendingInterruptReplyTo ? null : current));
  }, [clearInterruptTimeout, interruptPending, messages, pendingInterruptReplyTo]);

  const handleSend = async (content: string) => {
    if (interruptPending) {
      setComposerFeedback({
        variant: 'warning',
        message: 'Wait for the current interrupt to finish before sending another message.',
      });
      return;
    }
    if (restartPending) {
      setComposerFeedback({
        variant: 'warning',
        message: 'Wait for the task restart to finish before sending another message.',
      });
      return;
    }
    if (!isTaskRunning) {
      setComposerFeedback({
        code: 'task_not_ready',
        variant: 'warning',
        message:
          task?.status === 'completed'
            ? 'This task is already completed. Start a new run before sending more messages.'
            : task?.status === 'killed'
              ? 'This task has stopped. Restart it before sending more messages.'
              : 'The session is still starting. You can keep drafting, and send once the task is ready.',
      });
      return;
    }

    try {
      setComposerFeedback(null);
      clearRuntime(taskId);
      forceScrollToBottomRef.current = true;
      const message = await sendMessage(taskId, { content, role: 'user' });
      setInterruptTargetReplyTo(message.id);
    } catch {
      setComposerFeedback({
        variant: 'error',
        message: 'Failed to send the message. Please try again in a moment.',
      });
    }
  };

  const handleRestart = useCallback(async () => {
    if (interruptPending) {
      setComposerFeedback({
        variant: 'warning',
        message: 'Wait for the current interrupt to finish before restarting the AI session.',
      });
      return;
    }
    if (!restartEnabled) {
      return;
    }

    try {
      setComposerFeedback({
        code: 'restarting',
        variant: 'info',
        message: 'Restarting the current AI session…',
      });
      setRestartPending(true);

      await restartTask(taskId, {
        restartMode: 'refresh_session',
      });
      clearRuntime(taskId);
      setComposerFeedback(null);
    } catch (error) {
      setComposerFeedback({
        variant: 'error',
        message: error instanceof Error ? error.message : 'Failed to restart the AI task. Please try again.',
      });
    } finally {
      setRestartPending(false);
    }
  }, [clearRuntime, interruptPending, restartEnabled, restartTask, taskId]);

  const handleInterrupt = useCallback(async () => {
    if (restartPending) {
      setComposerFeedback({
        variant: 'warning',
        message: 'Wait for the task restart to finish before interrupting another reply.',
      });
      return;
    }
    const targetReplyTo = runtimeReplyTo || interruptTargetReplyTo || '';
    if (!targetReplyTo) {
      setComposerFeedback({
        variant: 'warning',
        message: 'The current reply is not ready to interrupt yet. Try again in a moment.',
      });
      return;
    }

    try {
      setComposerFeedback(null);
      setInterruptPending(true);
      setPendingInterruptReplyTo(targetReplyTo);
      setInterruptTargetReplyTo(targetReplyTo);
      clearInterruptTimeout();
      const api = getApiClient();
      await api.post(`/tasks/${taskId}/interrupt`, {
        target_reply_to: targetReplyTo,
      });
      interruptTimeoutRef.current = window.setTimeout(() => {
        interruptTimeoutRef.current = null;
        if (!interruptPendingRef.current) {
          return;
        }
        setInterruptPending(false);
        setPendingInterruptReplyTo(null);
        setComposerFeedback({
          variant: 'warning',
          message: 'Interrupt request was not confirmed. You can try again.',
        });
      }, INTERRUPT_CONFIRMATION_TIMEOUT_MS);
    } catch {
      clearInterruptTimeout();
      setInterruptPending(false);
      setPendingInterruptReplyTo(null);
      setComposerFeedback({
        variant: 'error',
        message: 'Failed to interrupt the current reply. Please try again in a moment.',
      });
    }
  }, [clearInterruptTimeout, interruptTargetReplyTo, restartPending, runtimeReplyTo, taskId]);

  const handleResend = (content: string) => {
    resendRequestIdRef.current += 1;
    setResendRequest({
      id: resendRequestIdRef.current,
      content,
    });
  };

  const handleScroll = () => {
    persistScrollPosition();

    const container = scrollContainerRef.current;
    if (!container || !hasMoreBefore || isLoading || !oldestMessageId) {
      if (!hasMoreBefore || !oldestMessageId) {
        autoLoadUntilFilledRef.current = false;
      }
      return;
    }

    if (container.scrollTop <= SCROLL_TOP_LOAD_THRESHOLD_PX) {
      void loadOlderMessages({ continueUntilFilled: true });
      return;
    }

    autoLoadUntilFilledRef.current = false;
  };

  return (
    <div className="flex h-full flex-col bg-paper">
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          className="webapp-scrollbar h-full overflow-y-auto px-4 py-5 md:px-6"
          onScroll={handleScroll}
        >
          {isLoading && messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner size="lg" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="w-full max-w-3xl rounded-3xl border border-dashed border-border bg-panel/70 px-8 py-10 text-center shadow-sm">
                <svg className="mx-auto mb-4 h-14 w-14 opacity-35" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-lg font-semibold text-ink">No messages yet</p>
                <p className="mt-2 text-sm text-muted">
                  {isTaskRunning
                    ? 'Ask Conductor what to do next, or paste a concrete task to get started.'
                    : 'The conversation history will appear here once the session is ready and messages start flowing.'}
                </p>
                {showEmptyStateRestart ? (
                  <button
                    type="button"
                    data-testid="empty-state-restart"
                    onClick={() => {
                      void handleRestart();
                    }}
                    disabled={!restartEnabled}
                    className="mt-5 inline-flex items-center justify-center rounded-xl border border-border bg-paper px-4 py-2 text-sm font-medium text-ink transition-colors hover:bg-border/35 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-paper"
                  >
                    {restartPending ? 'Restarting AI session…' : 'Restart AI session'}
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {hasMoreBefore ? (
                <div className="flex justify-center pb-1 text-xs text-muted">
                  <span className="rounded-full border border-border bg-panel/80 px-3 py-1.5">
                    {isLoading ? 'Loading older messages…' : 'Scroll to top to load older messages'}
                  </span>
                </div>
              ) : null}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  onResend={handleResend}
                  onRestart={() => {
                    void handleRestart();
                  }}
                  onInterrupt={() => {
                    void handleInterrupt();
                  }}
                  restartEnabled={restartEnabled}
                  restartPending={restartPending}
                  interruptEnabled={interruptEnabled}
                  interruptPending={interruptPending}
                />
              ))}
            </div>
          )}
        </div>
        {showScrollToBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest message"
            data-testid="scroll-to-bottom"
            className="absolute bottom-4 right-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-panel/80 text-ink shadow-md backdrop-blur-sm transition-colors hover:bg-border/50"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden
            >
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
          </button>
        ) : null}
      </div>
      <div className="border-t border-border bg-paper/40 px-4 py-3 md:px-6">
        <div className="w-full space-y-3">
          {aiRuntimeStatusText ? (
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <span className="rounded-full bg-border/50 px-2.5 py-1">
                {aiRuntimeStatusText}
              </span>
            </div>
          ) : null}
          {composerFeedback ? (
            <InlineNotice variant={composerFeedback.variant}>
              {composerFeedback.message}
            </InlineNotice>
          ) : null}
        </div>
      </div>
      <MessageInput
        taskId={taskId}
        onSend={handleSend}
        onInterrupt={() => {
          void handleInterrupt();
        }}
        sendDisabled={!isTaskRunning || interruptPending || restartPending}
        interruptEnabled={interruptEnabled}
        interruptPending={interruptPending}
        autoFocus={autoFocusComposer}
        resendRequest={resendRequest}
      />
    </div>
  );
}

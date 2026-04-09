'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { useRuntimeStore } from '@/features/realtime';
import { useTasksStore } from '@/features/tasks';
import { useWebSocketStore } from '@/features/realtime';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineNotice } from '@/components/common/InlineNotice';

interface ChatViewProps {
  taskId: string;
  autoFocusComposer?: boolean;
}

const SCROLL_STORAGE_PREFIX = 'conductor-task-scroll:';
const SCROLL_BOTTOM_THRESHOLD_PX = 40;
const SCROLL_TOP_LOAD_THRESHOLD_PX = 24;

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

export function ChatView({ taskId, autoFocusComposer = false }: ChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
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
  const websocketStatus = useWebSocketStore((state) => state.status);
  const task = tasks.find((t) => t.id === taskId);
  const isTaskRunning = task?.status === 'running';
  const [composerFeedback, setComposerFeedback] = useState<{
    variant: 'warning' | 'error';
    message: string;
  } | null>(null);

  const messages = messagesByTask[taskId] || [];
  const historyState = historyStateByTask[taskId];
  const isLoading = loadingTasks.has(taskId);
  const hasMoreBefore = historyState?.hasMoreBefore ?? false;
  const oldestMessageId = historyState?.oldestMessageId ?? null;
  const aiRuntimeStatusText = getAiRuntimeStatusText(runtime);

  const persistScrollPosition = (scrollTop?: number) => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const nextScrollTop = typeof scrollTop === 'number'
      ? clampScrollTop(container, scrollTop)
      : clampScrollTop(container, container.scrollTop);
    const stickToBottom = isNearBottom(container);

    shouldStickToBottomRef.current = stickToBottom;
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
    setComposerFeedback(null);
  }, [taskId]);

  useEffect(() => {
    if (isTaskRunning && composerFeedback?.variant === 'warning') {
      setComposerFeedback(null);
    }
  }, [composerFeedback?.variant, isTaskRunning]);

  const handleSend = async (content: string) => {
    if (!isTaskRunning) {
      setComposerFeedback({
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
      await sendMessage(taskId, { content, role: 'user' });
    } catch {
      setComposerFeedback({
        variant: 'error',
        message: 'Failed to send the message. Please try again in a moment.',
      });
    }
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
      <div
        ref={scrollContainerRef}
        className="webapp-scrollbar flex-1 overflow-y-auto px-4 py-5 md:px-6"
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
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
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
        sendDisabled={!isTaskRunning}
        autoFocus={autoFocusComposer}
      />
    </div>
  );
}

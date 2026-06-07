'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useChatStore } from '../store';
import { useRuntimeStore } from '@/features/realtime';
import { useTasksStore } from '@/features/tasks';
import { useWebSocketStore } from '@/features/realtime';
import { MessageBubble } from './MessageBubble';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { ScheduledMessageDialog } from './ScheduledMessageDialog';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineNotice } from '@/components/common/InlineNotice';
import { QuestionNav } from '@/components/common/QuestionNav';
import { getApiClient } from '@/shared/api/client';
import type { Message } from '@/shared/types';

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
// Pixels of scroll delta required before we treat a scroll event as an
// intentional directional change. Anything smaller is treated as noise (e.g.
// inertial bounce, sub-pixel reflows) so the nav doesn't flicker.
const SCROLL_DIRECTION_THRESHOLD_PX = 4;
// Vertical offset (in px) used when picking the "active" question dot. We bias
// toward the first user message whose top is near this offset below the
// scroll container's top edge.
const QUESTION_ACTIVE_OFFSET_PX = 80;
// Vertical offset (in px) applied above the target user message when a quick
// jump is requested. Leaves a little breathing room above the message so the
// timestamp / "older messages" header isn't covered.
const QUESTION_JUMP_TOP_PADDING_PX = 12;

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

type ComposerFeedback = {
  code?: 'task_not_ready' | 'restarting';
  variant: 'info' | 'warning' | 'error';
  message: string;
};

interface ChatViewUiState {
  composerFeedback: ComposerFeedback | null;
  interruptPending: boolean;
  latestSentReplyTo: string | null;
  awaitingRuntimeReply: boolean;
  restartPending: boolean;
}

type ChatViewUiAction =
  | { type: 'clearTaskNotReadyFeedback' }
  | { type: 'interruptRequested' }
  | { type: 'recordSentMessage'; replyTo: string }
  | { type: 'runtimeReplyStarted' }
  | { type: 'runtimeReplyStopped' }
  | { type: 'setComposerFeedback'; feedback: ComposerFeedback | null }
  | { type: 'setRestartPending'; value: boolean }
  | { type: 'settleInterrupt' };

const EMPTY_MESSAGES: Message[] = [];

const INITIAL_CHAT_VIEW_UI_STATE: ChatViewUiState = {
  composerFeedback: null,
  interruptPending: false,
  latestSentReplyTo: null,
  awaitingRuntimeReply: false,
  restartPending: false,
};

const chatViewUiReducer = (state: ChatViewUiState, action: ChatViewUiAction): ChatViewUiState => {
  switch (action.type) {
    case 'clearTaskNotReadyFeedback':
      return state.composerFeedback?.code === 'task_not_ready'
        ? { ...state, composerFeedback: null }
        : state;
    case 'interruptRequested':
      return state.interruptPending ? state : { ...state, interruptPending: true };
    case 'recordSentMessage':
      return {
        ...state,
        latestSentReplyTo: action.replyTo,
        awaitingRuntimeReply: true,
      };
    case 'runtimeReplyStarted':
      return state.awaitingRuntimeReply
        ? { ...state, awaitingRuntimeReply: false }
        : state;
    case 'runtimeReplyStopped':
      if (!state.interruptPending && !state.latestSentReplyTo && !state.awaitingRuntimeReply) {
        return state;
      }
      return {
        ...state,
        interruptPending: false,
        latestSentReplyTo: null,
        awaitingRuntimeReply: false,
      };
    case 'setComposerFeedback':
      return state.composerFeedback == action.feedback
        ? state
        : { ...state, composerFeedback: action.feedback };
    case 'setRestartPending':
      return state.restartPending === action.value
        ? state
        : { ...state, restartPending: action.value };
    case 'settleInterrupt':
      return state.interruptPending
        ? { ...state, interruptPending: false }
        : state;
    default:
      return state;
  }
};

export function ChatView(props: ChatViewProps) {
  return <TaskScopedChatView key={props.taskId} {...props} />;
}

function TaskScopedChatView({ taskId, autoFocusComposer = false }: ChatViewProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const interruptTimeoutRef = useRef<number | null>(null);
  const interruptPendingRef = useRef(false);
  const previousRuntimeReplyInProgressRef = useRef(false);
  const previousMessageCountRef = useRef(0);
  const pendingRestoreScrollStateRef = useRef<StoredScrollState | null>(readStoredScrollState(taskId));
  const pendingPrependAnchorRef = useRef<{ previousScrollHeight: number; previousScrollTop: number } | null>(null);
  const autoLoadUntilFilledRef = useRef(false);
  const shouldRestoreScrollRef = useRef(true);
  const shouldStickToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const previousWebSocketStatusRef = useRef<'connected' | 'connecting' | 'disconnected' | null>(null);
  const pendingInterruptReplyToRef = useRef<string | null>(null);
  const messageInputRef = useRef<MessageInputHandle>(null);
  const { messagesByTask, historyStateByTask, loadingTasks, fetchMessages, sendMessage } = useChatStore();
  const runtime = useRuntimeStore((state) => state.byTask[taskId]);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const tasks = useTasksStore((state) => state.tasks);
  const restartTask = useTasksStore((state) => state.restartTask);
  const websocketStatus = useWebSocketStore((state) => state.status);
  const task = tasks.find((t) => t.id === taskId);
  const isTaskRunning = task?.status === 'running';
  const [uiState, dispatchUiState] = useReducer(chatViewUiReducer, INITIAL_CHAT_VIEW_UI_STATE);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showQuestionNav, setShowQuestionNav] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [scheduledMessage, setScheduledMessage] = useState<Message | null>(null);
  const questionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isJumpingQuestionRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  // Pending requestAnimationFrame handle for active-dot recomputation, so we
  // throttle the (O(N) getBoundingClientRect) scan to at most once per frame.
  const activeQuestionRafRef = useRef<number | null>(null);

  const messages = messagesByTask[taskId] ?? EMPTY_MESSAGES;
  const userQuestionIndexByMessageIndex = useMemo(() => {
    const map = new Map<number, number>();
    let q = 0;
    messages.forEach((msg, i) => {
      if (msg.role === 'user') {
        map.set(i, q);
        q += 1;
      }
    });
    return map;
  }, [messages]);
  const userQuestionCount = userQuestionIndexByMessageIndex.size;
  const historyState = historyStateByTask[taskId];
  const isLoading = loadingTasks.has(taskId);
  const hasMoreBefore = historyState?.hasMoreBefore ?? false;
  const oldestMessageId = historyState?.oldestMessageId ?? null;
  const aiRuntimeStatusText = getAiRuntimeStatusText(runtime);
  const runtimeReplyInProgress = Boolean(runtime?.replyInProgress);
  const runtimeReplyTo =
    runtimeReplyInProgress && typeof runtime?.replyTo === 'string' ? runtime.replyTo.trim() : '';
  const interruptedReplyTargets = useMemo(() => {
    const targets = new Set<string>();
    messages.forEach((message) => {
      const target = getMessageReplyTarget(message);
      if (target && isInterruptConfirmationMessage(message, target)) {
        targets.add(target);
      }
    });
    return targets;
  }, [messages]);
  const fallbackInterruptReplyTo = useMemo(() => {
    if (!uiState.latestSentReplyTo) {
      return '';
    }
    return uiState.awaitingRuntimeReply || runtimeReplyInProgress
      ? uiState.latestSentReplyTo
      : '';
  }, [runtimeReplyInProgress, uiState.awaitingRuntimeReply, uiState.latestSentReplyTo]);
  const activeInterruptCandidate = runtimeReplyTo || fallbackInterruptReplyTo;
  const activeInterruptReplyTo = activeInterruptCandidate && !interruptedReplyTargets.has(activeInterruptCandidate)
    ? activeInterruptCandidate
    : '';
  const pendingInterruptReplyTo = pendingInterruptReplyToRef.current;
  const hasPendingInterruptConfirmation = useMemo(() => (
    Boolean(
      uiState.interruptPending
      && pendingInterruptReplyTo
      && messages.some((message) => isInterruptConfirmationMessage(message, pendingInterruptReplyTo))
    )
  ), [messages, pendingInterruptReplyTo, uiState.interruptPending]);
  const restartPending = uiState.restartPending;
  const interruptPending = uiState.interruptPending;
  const composerFeedback = uiState.composerFeedback;
  const visibleComposerFeedback = useMemo(() => (
    composerFeedback?.code === 'task_not_ready' && isTaskRunning ? null : composerFeedback
  ), [composerFeedback, isTaskRunning]);
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

  const persistScrollPosition = useCallback((scrollTop?: number) => {
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
  }, [taskId]);

  const scrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const nextScrollTop = getMaxScrollTop(container);
    // Seed the direction baseline before mutating scrollTop. Some browsers
    // dispatch `scroll` synchronously on assignment, and we must not have a
    // stale baseline when handleScroll runs.
    lastScrollTopRef.current = nextScrollTop;
    container.scrollTop = nextScrollTop;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    setShowQuestionNav(false);
    writeStoredScrollState(taskId, {
      scrollTop: nextScrollTop,
      stickToBottom: true,
    });
  }, [taskId]);

  const handleJumpToQuestion = useCallback((questionIndex: number) => {
    const el = questionRefs.current.get(questionIndex);
    const container = scrollContainerRef.current;
    if (!el || !container) {
      return;
    }
    isJumpingQuestionRef.current = true;
    const containerTop = container.getBoundingClientRect().top;
    const elTop = el.getBoundingClientRect().top;
    const nextScrollTop = clampScrollTop(
      container,
      container.scrollTop + (elTop - containerTop) - QUESTION_JUMP_TOP_PADDING_PX,
    );
    // Seed the direction baseline before mutating scrollTop so the resulting
    // scroll event (which may fire synchronously) doesn't see a stale value.
    // The isJumpingQuestionRef guard short-circuits handleScroll anyway, but
    // keeping the baseline accurate avoids surprising future readers.
    lastScrollTopRef.current = nextScrollTop;
    container.scrollTop = nextScrollTop;
    setActiveQuestion(questionIndex);
    window.setTimeout(() => {
      isJumpingQuestionRef.current = false;
    }, 120);
  }, []);

  const loadOlderMessages = useCallback(async (options?: { continueUntilFilled?: boolean }) => {
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
  }, [fetchMessages, isLoading, oldestMessageId, taskId]);

  const maybeContinueAutoLoadUntilFilled = useCallback(() => {
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
  }, [hasMoreBefore, isLoading, loadOlderMessages, oldestMessageId]);

  useEffect(() => {
    fetchMessages(taskId);
  }, [fetchMessages, taskId]);

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

  // Cancel any in-flight active-dot recomputation when the component
  // unmounts so we don't call setState on a stale instance.
  useEffect(() => () => {
    if (activeQuestionRafRef.current !== null) {
      window.cancelAnimationFrame(activeQuestionRafRef.current);
      activeQuestionRafRef.current = null;
    }
  }, []);

  useEffect(() => (
    () => {
      persistScrollPosition();
    }
  ), [persistScrollPosition]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    if (pendingPrependAnchorRef.current) {
      const { previousScrollHeight, previousScrollTop } = pendingPrependAnchorRef.current;
      const delta = container.scrollHeight - previousScrollHeight;
      const nextScrollTop = clampScrollTop(container, previousScrollTop + delta);
      // Resync the scroll-direction baseline before the assignment so the
      // synthetic scrollTop bump from prepending older messages doesn't get
      // misread as the user scrolling downward (which would hide the
      // quick-jump nav mid-load) on browsers that dispatch scroll
      // synchronously.
      lastScrollTopRef.current = nextScrollTop;
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
        // Seed the direction baseline before mutating scrollTop so the
        // upcoming scroll event from restoring position doesn't get treated
        // as a real user scroll.
        lastScrollTopRef.current = nextScrollTop;
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
  }, [
    isLoading,
    maybeContinueAutoLoadUntilFilled,
    messages.length,
    persistScrollPosition,
    scrollToBottom,
  ]);

  useEffect(() => {
    if (isTaskRunning && composerFeedback?.code === 'task_not_ready') {
      dispatchUiState({ type: 'clearTaskNotReadyFeedback' });
    }
  }, [composerFeedback?.code, isTaskRunning]);

  useEffect(() => {
    if (!visibleComposerFeedback) {
      return;
    }
    // Skip progress-style notices (e.g. "Restarting the current AI session…")
    // that must persist until the underlying operation completes. Those notices
    // are cleared explicitly in their own finally/catch paths.
    if (visibleComposerFeedback.code === 'restarting') {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      dispatchUiState({ type: 'setComposerFeedback', feedback: null });
    }, COMPOSER_FEEDBACK_AUTO_DISMISS_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [visibleComposerFeedback]);

  useEffect(() => {
    const wasRuntimeReplyInProgress = previousRuntimeReplyInProgressRef.current;
    previousRuntimeReplyInProgressRef.current = runtimeReplyInProgress;

    if (runtimeReplyInProgress) {
      if (!wasRuntimeReplyInProgress) {
        dispatchUiState({ type: 'runtimeReplyStarted' });
      }
      return;
    }

    if (!wasRuntimeReplyInProgress) {
      return;
    }

    clearInterruptTimeout();
    pendingInterruptReplyToRef.current = null;
    dispatchUiState({ type: 'runtimeReplyStopped' });
  }, [clearInterruptTimeout, runtimeReplyInProgress]);

  useEffect(() => {
    if (!hasPendingInterruptConfirmation) {
      return;
    }

    clearInterruptTimeout();
    pendingInterruptReplyToRef.current = null;
    dispatchUiState({ type: 'settleInterrupt' });
  }, [clearInterruptTimeout, hasPendingInterruptConfirmation]);

  const handleSend = async (content: string) => {
    if (interruptPending) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Wait for the current interrupt to finish before sending another message.',
        },
      });
      return;
    }
    if (restartPending) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Wait for the task restart to finish before sending another message.',
        },
      });
      return;
    }
    if (!isTaskRunning) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          code: 'task_not_ready',
          variant: 'warning',
          message:
            task?.status === 'completed'
              ? 'This task is already completed. Start a new run before sending more messages.'
              : task?.status === 'killed'
                ? 'This task has stopped. Restart it before sending more messages.'
                : 'The session is still starting. You can keep drafting, and send once the task is ready.',
        },
      });
      return;
    }

    try {
      dispatchUiState({ type: 'setComposerFeedback', feedback: null });
      clearRuntime(taskId);
      forceScrollToBottomRef.current = true;
      const message = await sendMessage(taskId, { content, role: 'user' });
      dispatchUiState({ type: 'recordSentMessage', replyTo: message.id });
    } catch {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'error',
          message: 'Failed to send the message. Please try again in a moment.',
        },
      });
    }
  };

  const handleScheduleMessage = useCallback((message: Message) => {
    setScheduledMessage(message);
  }, []);

  const handleRestart = useCallback(async () => {
    if (interruptPending) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Wait for the current interrupt to finish before restarting the AI session.',
        },
      });
      return;
    }
    if (!restartEnabled) {
      return;
    }

    try {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          code: 'restarting',
          variant: 'info',
          message: 'Restarting the current AI session…',
        },
      });
      dispatchUiState({ type: 'setRestartPending', value: true });

      await restartTask(taskId, {
        restartMode: 'refresh_session',
      });
      clearRuntime(taskId);
      dispatchUiState({ type: 'setComposerFeedback', feedback: null });
    } catch (error) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'error',
          message: error instanceof Error ? error.message : 'Failed to restart the AI task. Please try again.',
        },
      });
    } finally {
      dispatchUiState({ type: 'setRestartPending', value: false });
    }
  }, [clearRuntime, interruptPending, restartEnabled, restartTask, taskId]);

  const handleInterrupt = useCallback(async () => {
    if (restartPending) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Wait for the task restart to finish before interrupting another reply.',
        },
      });
      return;
    }
    if (!activeInterruptReplyTo) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'The current reply is not ready to interrupt yet. Try again in a moment.',
        },
      });
      return;
    }

    try {
      dispatchUiState({ type: 'setComposerFeedback', feedback: null });
      dispatchUiState({ type: 'interruptRequested' });
      pendingInterruptReplyToRef.current = activeInterruptReplyTo;
      clearInterruptTimeout();
      const api = getApiClient();
      await api.post(`/tasks/${taskId}/interrupt`, {
        target_reply_to: activeInterruptReplyTo,
      });
      interruptTimeoutRef.current = window.setTimeout(() => {
        interruptTimeoutRef.current = null;
        if (!interruptPendingRef.current) {
          return;
        }
        pendingInterruptReplyToRef.current = null;
        dispatchUiState({ type: 'settleInterrupt' });
        dispatchUiState({
          type: 'setComposerFeedback',
          feedback: {
            variant: 'warning',
            message: 'Interrupt request was not confirmed. You can try again.',
          },
        });
      }, INTERRUPT_CONFIRMATION_TIMEOUT_MS);
    } catch {
      clearInterruptTimeout();
      pendingInterruptReplyToRef.current = null;
      dispatchUiState({ type: 'settleInterrupt' });
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'error',
          message: 'Failed to interrupt the current reply. Please try again in a moment.',
        },
      });
    }
  }, [activeInterruptReplyTo, clearInterruptTimeout, restartPending, taskId]);

  const handleResend = useCallback((content: string) => {
    messageInputRef.current?.resend(content);
  }, []);

  const handleScroll = () => {
    persistScrollPosition();

    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const currentScrollTop = container.scrollTop;
    const delta = currentScrollTop - lastScrollTopRef.current;

    // Toggle the quick-jump nav based on scroll direction. Show when the user
    // intentionally scrolls upward (toward older messages); hide on natural
    // downward reading. Ignore tiny deltas and programmatic jumps so the nav
    // doesn't flicker.
    if (!isJumpingQuestionRef.current && userQuestionCount > 1) {
      if (delta <= -SCROLL_DIRECTION_THRESHOLD_PX) {
        setShowQuestionNav(true);
      } else if (delta >= SCROLL_DIRECTION_THRESHOLD_PX) {
        setShowQuestionNav(false);
      }
    }

    // Recompute the active question dot at most once per animation frame.
    // The scan calls getBoundingClientRect on every user-message element, so
    // for long conversations doing it on every scroll tick would force a
    // layout per tick. Coalescing into a single rAF keeps it cheap while
    // still feeling instant. We skip entirely while a programmatic jump is
    // in flight so we don't fight the click handler.
    if (
      !isJumpingQuestionRef.current &&
      questionRefs.current.size > 0 &&
      activeQuestionRafRef.current === null
    ) {
      activeQuestionRafRef.current = window.requestAnimationFrame(() => {
        activeQuestionRafRef.current = null;
        // A jump click between the schedule and the callback can land within
        // the same animation frame. Re-check the flag here (the scheduling
        // guard above isn't enough) so we never overwrite the activeQuestion
        // that `handleJumpToQuestion` just set.
        if (isJumpingQuestionRef.current) return;
        const c = scrollContainerRef.current;
        if (!c) return;
        const containerTop = c.getBoundingClientRect().top;
        let closest = 0;
        let closestDist = Infinity;
        questionRefs.current.forEach((el, idx) => {
          const dist = Math.abs(el.getBoundingClientRect().top - containerTop - QUESTION_ACTIVE_OFFSET_PX);
          if (dist < closestDist) {
            closestDist = dist;
            closest = idx;
          }
        });
        setActiveQuestion((current) => (current === closest ? current : closest));
      });
    }

    lastScrollTopRef.current = currentScrollTop;

    if (!hasMoreBefore || isLoading || !oldestMessageId) {
      if (!hasMoreBefore || !oldestMessageId) {
        autoLoadUntilFilledRef.current = false;
      }
      return;
    }

    if (currentScrollTop <= SCROLL_TOP_LOAD_THRESHOLD_PX) {
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
                <svg className="mx-auto mb-4 size-14 opacity-35" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              {messages.map((message, msgIndex) => {
                const qIdx = userQuestionIndexByMessageIndex.get(msgIndex);
                const bubble = (
                  <MessageBubble
                    message={message}
                    onResend={handleResend}
                    onSchedule={handleScheduleMessage}
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
                );
                if (qIdx == null) {
                  return <div key={message.id}>{bubble}</div>;
                }
                return (
                  <div
                    key={message.id}
                    ref={(el) => {
                      if (el) {
                        questionRefs.current.set(qIdx, el);
                      } else {
                        questionRefs.current.delete(qIdx);
                      }
                    }}
                  >
                    {bubble}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <QuestionNav
          count={userQuestionCount}
          activeIndex={activeQuestion}
          visible={showQuestionNav && userQuestionCount > 1}
          onJump={handleJumpToQuestion}
          // `absolute` so the nav anchors to the scroll-area wrapper, not the
          // viewport. `right-4` clears the custom `webapp-scrollbar` gutter
          // on platforms with persistent scrollbars and visually aligns with
          // the "scroll to latest" button below.
          className="absolute right-4"
        />
        {showScrollToBottom ? (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label="Scroll to latest message"
            data-testid="scroll-to-bottom"
            className="absolute bottom-4 right-4 z-10 flex size-9 items-center justify-center rounded-full border border-border bg-panel/80 text-ink shadow-md backdrop-blur-sm transition-colors hover:bg-border/50"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="size-4"
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
          {visibleComposerFeedback ? (
            <InlineNotice variant={visibleComposerFeedback.variant}>
              {visibleComposerFeedback.message}
            </InlineNotice>
          ) : null}
        </div>
      </div>
      <MessageInput
        ref={messageInputRef}
        taskId={taskId}
        onSend={handleSend}
        onInterrupt={() => {
          void handleInterrupt();
        }}
        sendDisabled={!isTaskRunning || interruptPending || restartPending}
        interruptEnabled={interruptEnabled}
        interruptPending={interruptPending}
        autoFocus={autoFocusComposer}
      />
      <ScheduledMessageDialog
        open={scheduledMessage !== null}
        taskId={taskId}
        message={scheduledMessage}
        onClose={() => setScheduledMessage(null)}
      />
    </div>
  );
}

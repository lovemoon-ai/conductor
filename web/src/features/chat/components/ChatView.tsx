'use client';

import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useChatStore } from '../store';
import { ChatMenuSlotContext } from '../chat-menu-slot';
import { requestTaskRuntimeStatus, useRuntimeStore } from '@/features/realtime';
import { useProjectsStore } from '@/features/projects';
import { useTasksStore } from '@/features/tasks';
import { useWebSocketStore } from '@/features/realtime';
import { MessageBubble } from './MessageBubble';
import { MessageInput, type MessageInputHandle } from './MessageInput';
import { ScheduledMessageDialog } from './ScheduledMessageDialog';
import { buildPersistentRoundGroups, PersistentRoundHeader } from './PersistentRounds';
import { NewRoundDialog, PersistentTaskSettingsDialog } from '@/features/tasks/components/PersistentTaskDialogs';
import { PERSISTENT_ROUND_END_KIND, readPersistentTaskState } from '@/shared/utils/persistent-task';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineNotice } from '@/components/common/InlineNotice';
import { QuestionNav } from '@/components/common/QuestionNav';
import { getApiClient } from '@/shared/api/client';
import { useReadingSize } from '@/features/workspace/preferences';
import { ReadingSettings } from '@/features/workspace/WorkspaceControls';
import type { CSSProperties } from 'react';
import type { Message, StartTaskRoundInput } from '@/shared/types';

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
const getExpandedRoundsStorageKey = (taskId: string) => `conductor-chat-expanded-rounds:${taskId}`;

const readStoredExpandedRounds = (taskId: string): Set<number> => {
  if (typeof window === 'undefined') return new Set();
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(getExpandedRoundsStorageKey(taskId)) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((round) => Number.isInteger(round)) : []);
  } catch {
    return new Set();
  }
};

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
  insertPending: boolean;
  latestSentReplyTo: string | null;
  awaitingRuntimeReply: boolean;
  restartPending: boolean;
}

type ChatViewUiAction =
  | { type: 'clearTaskNotReadyFeedback' }
  | { type: 'interruptRequested' }
  | { type: 'insertRequested' }
  | { type: 'recordSentMessage'; replyTo: string }
  | { type: 'runtimeReplyStarted' }
  | { type: 'runtimeReplyStopped' }
  | { type: 'setComposerFeedback'; feedback: ComposerFeedback | null }
  | { type: 'setRestartPending'; value: boolean }
  | { type: 'settleInterrupt' }
  | { type: 'settleInsert' };

const EMPTY_MESSAGES: Message[] = [];
const CHAT_MENU_ITEM_CLASS_NAME = 'flex min-h-9 w-full items-center rounded px-2 text-left hover:bg-paper disabled:opacity-40 disabled:hover:bg-transparent';

const INITIAL_CHAT_VIEW_UI_STATE: ChatViewUiState = {
  composerFeedback: null,
  interruptPending: false,
  insertPending: false,
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
    case 'insertRequested':
      return state.insertPending ? state : { ...state, insertPending: true };
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
      if (
        !state.interruptPending &&
        !state.insertPending &&
        !state.latestSentReplyTo &&
        !state.awaitingRuntimeReply
      ) {
        return state;
      }
      return {
        ...state,
        interruptPending: false,
        insertPending: false,
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
    case 'settleInsert':
      return state.insertPending
        ? { ...state, insertPending: false }
        : state;
    default:
      return state;
  }
};

export function ChatView(props: ChatViewProps) {
  return <TaskScopedChatView key={props.taskId} {...props} />;
}

function TaskScopedChatView({ taskId, autoFocusComposer = false }: ChatViewProps) {
  const [readingSize] = useReadingSize();
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const interruptTimeoutRef = useRef<number | null>(null);
  const interruptPendingRef = useRef(false);
  const insertTimeoutRef = useRef<number | null>(null);
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
  const messages = useChatStore((state) => state.messagesByTask[taskId] ?? EMPTY_MESSAGES);
  const historyState = useChatStore((state) => state.historyStateByTask[taskId]);
  const isLoading = useChatStore((state) => state.loadingTasks.has(taskId));
  const fetchMessages = useChatStore((state) => state.fetchMessages);
  const sendMessage = useChatStore((state) => state.sendMessage);
  const uploadAttachments = useChatStore((state) => state.uploadAttachments);
  const clearUploadedAttachmentCache = useChatStore((state) => state.clearUploadedAttachmentCache);
  const insertMessage = useChatStore((state) => state.insertMessage);
  const runtime = useRuntimeStore((state) => state.byTask[taskId]);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const task = useTasksStore((state) => state.tasks.find((item) => item.id === taskId));
  const fetchTask = useTasksStore((state) => state.fetchTask);
  const restartTask = useTasksStore((state) => state.restartTask);
  const startTaskRound = useTasksStore((state) => state.startTaskRound);
  const endTaskRound = useTasksStore((state) => state.endTaskRound);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const websocketStatus = useWebSocketStore((state) => state.status);
  const isTaskRunning = task?.status === 'running';
  const [uiState, dispatchUiState] = useReducer(chatViewUiReducer, INITIAL_CHAT_VIEW_UI_STATE);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [showQuestionNav, setShowQuestionNav] = useState(false);
  const [activeQuestion, setActiveQuestion] = useState(0);
  const [scheduledMessage, setScheduledMessage] = useState<Message | null>(null);
  // RFC 0039 persistent tasks.
  const [expandedRounds, setExpandedRounds] = useState<Set<number>>(() => readStoredExpandedRounds(taskId));
  const [isNewRoundDialogOpen, setIsNewRoundDialogOpen] = useState(false);
  const [isPersistentDialogOpen, setIsPersistentDialogOpen] = useState(false);
  const chatMenuSlot = useContext(ChatMenuSlotContext);
  const [roundActionPending, setRoundActionPending] = useState(false);
  const questionRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const isJumpingQuestionRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  // Pending requestAnimationFrame handle for active-dot recomputation, so we
  // throttle the (O(N) getBoundingClientRect) scan to at most once per frame.
  const activeQuestionRafRef = useRef<number | null>(null);

  const roundGroups = useMemo(() => buildPersistentRoundGroups(messages), [messages]);
  const roundGroupByStartIndex = useMemo(
    () => new Map(roundGroups.map((group) => [group.startIndex, group] as const)),
    [roundGroups],
  );
  const collapsedMessageIndices = useMemo(() => {
    const indices = new Set<number>();
    roundGroups.slice(0, -1).forEach((group) => {
      if (expandedRounds.has(group.round)) return;
      for (let index = group.startIndex; index < group.endIndex; index += 1) indices.add(index);
    });
    return indices;
  }, [expandedRounds, roundGroups]);
  const userQuestionIndexByMessageIndex = useMemo(() => {
    const map = new Map<number, number>();
    let q = 0;
    messages.forEach((msg, i) => {
      if (msg.role === 'user' && !collapsedMessageIndices.has(i) && msg.metadata?.kind !== PERSISTENT_ROUND_END_KIND) {
        map.set(i, q);
        q += 1;
      }
    });
    return map;
  }, [collapsedMessageIndices, messages]);
  const userQuestionCount = userQuestionIndexByMessageIndex.size;
  const persistentState = readPersistentTaskState(task?.metadata);
  const isPersistent = persistentState?.enabled === true;
  // Idle = the round was ended, or its session is gone: sending starts a new round.
  const isRoundIdle = Boolean(
    isPersistent &&
    (persistentState?.roundEndedAt ||
      task?.status === 'completed' ||
      task?.status === 'killed' ||
      task?.status === 'unknown'),
  );
  const roundEndMessageId = persistentState?.roundEndMessageId ?? null;
  const hasMoreBefore = historyState?.hasMoreBefore ?? false;
  const oldestMessageId = historyState?.oldestMessageId ?? null;
  const aiRuntimeStatusText = getAiRuntimeStatusText(runtime);
  const runtimeReplyInProgress = Boolean(runtime?.replyInProgress);
  const runtimeReplyTo =
    runtimeReplyInProgress && typeof runtime?.replyTo === 'string' ? runtime.replyTo.trim() : '';
  // The AI is still answering the end-of-round summary request (no reply yet, or
  // still streaming it); a new round now would cut the summary off.
  const isRoundSummaryPending = Boolean(
    isPersistent &&
    roundEndMessageId &&
    task?.status === 'running' &&
    (runtimeReplyTo === roundEndMessageId ||
      !messages.some((message) => message.role !== 'user' && message.metadata?.reply_to === roundEndMessageId)),
  );
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
  const insertPending = uiState.insertPending;
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
  const insertEnabled = Boolean(
    isTaskRunning && activeInterruptReplyTo && !restartPending && !interruptPending && !insertPending,
  );
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

    // Older pages would land in a collapsed round and add no height, so filling
    // the viewport this way could walk the whole history; load on request instead.
    if (!hasMoreBefore || !oldestMessageId || collapsedMessageIndices.has(0)) {
      autoLoadUntilFilledRef.current = false;
      return;
    }

    if (container.scrollHeight > container.clientHeight + SCROLL_TOP_LOAD_THRESHOLD_PX) {
      autoLoadUntilFilledRef.current = false;
      return;
    }

    void loadOlderMessages({ continueUntilFilled: true });
  }, [collapsedMessageIndices, hasMoreBefore, isLoading, loadOlderMessages, oldestMessageId]);

  useEffect(() => {
    fetchMessages(taskId);
  }, [fetchMessages, taskId]);

  useEffect(() => (
    () => {
      clearInterruptTimeout();
      if (insertTimeoutRef.current !== null) {
        window.clearTimeout(insertTimeoutRef.current);
        insertTimeoutRef.current = null;
      }
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

  // Runtime status frames are not replayed on page load or reconnect; ask the
  // task's fire to re-report (e.g. the tool a long silent turn is running).
  useEffect(() => {
    if (isTaskRunning && websocketStatus === 'connected') {
      requestTaskRuntimeStatus(taskId);
    }
  }, [isTaskRunning, taskId, websocketStatus]);

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

  const startRound = async (input: Omit<StartTaskRoundInput, 'expectedRound'>) => {
    dispatchUiState({ type: 'setComposerFeedback', feedback: null });
    setRoundActionPending(true);
    clearRuntime(taskId);
    forceScrollToBottomRef.current = true;
    try {
      await startTaskRound(taskId, { ...input, expectedRound: persistentState?.round ?? 1 });
    } finally {
      setRoundActionPending(false);
    }
  };

  const handleSend = async (content: string, files: File[] = []) => {
    let attachmentsUploaded = false;
    if (interruptPending) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Wait for the current interrupt to finish before sending another message.',
        },
      });
      if (files.length) throw new Error('Interrupt in progress');
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
      if (files.length) throw new Error('Restart in progress');
      return;
    }
    if (isRoundIdle) {
      if (files.length) {
        dispatchUiState({
          type: 'setComposerFeedback',
          feedback: {
            variant: 'warning',
            message: 'Start the new round with a text message, then attach files.',
          },
        });
        throw new Error('Attachments cannot start a round');
      }
      try {
        await startRound({ content });
      } catch (error) {
        messageInputRef.current?.restoreDraft(content);
        dispatchUiState({
          type: 'setComposerFeedback',
          feedback: {
            variant: 'error',
            message: error instanceof Error ? error.message : 'Failed to start a new round.',
          },
        });
        throw new Error('Failed to start a new round');
      }
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
      if (files.length) throw new Error('Task is not ready');
      return;
    }

    try {
      dispatchUiState({ type: 'setComposerFeedback', feedback: null });
      clearRuntime(taskId);
      forceScrollToBottomRef.current = true;
      const attachmentIds = files.length ? await uploadAttachments(taskId, files) : [];
      attachmentsUploaded = attachmentIds.length > 0;
      const message = await sendMessage(taskId, {
        content: content || (files.length ? `Attached ${files.length} file${files.length === 1 ? '' : 's'}` : ''),
        role: 'user',
        ...(attachmentIds.length ? { attachmentIds } : {}),
      });
      if (files.length) clearUploadedAttachmentCache(taskId, files);
      dispatchUiState({ type: 'recordSentMessage', replyTo: message.id });
    } catch {
      if (attachmentsUploaded) clearUploadedAttachmentCache(taskId, files);
      // The send (including its bounded auto-retry for the startup fire-owner
      // race) ultimately failed. Put the text back so the user never loses it.
      messageInputRef.current?.restoreDraft(content);
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'error',
          message: 'Failed to send the message. Please try again in a moment.',
        },
      });
      throw new Error('Failed to upload attachments or send message');
    }
  };

  const handleEndRound = async () => {
    setRoundActionPending(true);
    try {
      await endTaskRound(taskId);
    } catch (error) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'error',
          message: error instanceof Error ? error.message : 'Failed to end the round.',
        },
      });
    } finally {
      setRoundActionPending(false);
    }
  };

  const handleScheduleMessage = useCallback((message: Message) => {
    setScheduledMessage(message);
  }, []);

  const handleScheduleDraft = useCallback(() => {
    // Schedule the current composer draft: a message with no persisted id so
    // the dialog treats it as a fresh scheduled message, not a reschedule.
    setScheduledMessage({ id: '', taskId, role: 'user', content: messageInputRef.current?.getDraft() ?? '' });
  }, [taskId]);

  const refreshScheduledMessageSummary = useCallback(() => {
    void fetchTask(taskId);
    void fetchProjects();
  }, [fetchProjects, fetchTask, taskId]);

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

  const handleInsert = useCallback(async (content: string) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }
    if (restartPending || interruptPending || insertPending) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Wait for the current action to finish before inserting a message.',
        },
      });
      return;
    }
    if (!isTaskRunning || !activeInterruptReplyTo) {
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'warning',
          message: 'Insert is only available while a reply is in progress.',
        },
      });
      return;
    }

    const targetReplyTo = activeInterruptReplyTo;
    const clearInsertTimeout = () => {
      if (insertTimeoutRef.current !== null) {
        window.clearTimeout(insertTimeoutRef.current);
        insertTimeoutRef.current = null;
      }
    };
    try {
      dispatchUiState({ type: 'setComposerFeedback', feedback: null });
      dispatchUiState({ type: 'insertRequested' });
      forceScrollToBottomRef.current = true;
      clearInsertTimeout();
      // Safety net: clear the pending flag even if the runtime never reports a
      // new reply (the reducer also clears it on the next runtimeReplyStopped).
      insertTimeoutRef.current = window.setTimeout(() => {
        insertTimeoutRef.current = null;
        dispatchUiState({ type: 'settleInsert' });
      }, INTERRUPT_CONFIRMATION_TIMEOUT_MS);
      await insertMessage(taskId, { content: trimmed, targetReplyTo });
      // The request is delivered; settle immediately rather than waiting on the
      // runtime to report a new reply (which may not happen when the insert only
      // queues, e.g. the turn already finished). The timeout is just a backstop.
      clearInsertTimeout();
      dispatchUiState({ type: 'settleInsert' });
    } catch {
      clearInsertTimeout();
      dispatchUiState({ type: 'settleInsert' });
      dispatchUiState({
        type: 'setComposerFeedback',
        feedback: {
          variant: 'error',
          message: 'Failed to insert the message. Please try again in a moment.',
        },
      });
    }
  }, [activeInterruptReplyTo, insertMessage, insertPending, interruptPending, isTaskRunning, restartPending, taskId]);

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
    <div data-chat-viewport className="compact-chat flex h-full min-w-0 flex-col bg-panel" style={{ '--reading-size': readingSize ? `${readingSize}px` : undefined } as CSSProperties}>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollContainerRef}
          // pan-y keeps horizontal drags for the mobile task-switch swipe.
          className="webapp-scrollbar h-full touch-pan-y overflow-y-auto px-3 py-2 md:px-4"
          onScroll={handleScroll}
        >
          {isLoading && messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner size="lg" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex h-full items-center justify-center">
              <div className="w-full max-w-lg px-8 py-10 text-center">
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
            <div className="chat-messages w-full space-y-2">
              {hasMoreBefore ? (
                <div className="flex justify-center pb-1 text-xs text-muted">
                  <button
                    type="button"
                    onClick={() => void loadOlderMessages()}
                    disabled={isLoading}
                    className="rounded-full border border-border bg-panel/80 px-3 py-1.5"
                  >
                    {isLoading ? 'Loading older messages…' : 'Scroll to top to load older messages'}
                  </button>
                </div>
              ) : null}
              {messages.map((message, msgIndex) => {
                const roundGroup = roundGroupByStartIndex.get(msgIndex);
                const roundCollapsed = collapsedMessageIndices.has(msgIndex);
                const roundHeader = roundGroup ? (
                  <PersistentRoundHeader
                    // The first loaded round may have started on a page not loaded yet.
                    group={hasMoreBefore && !roundGroup.divider ? { ...roundGroup, startedAt: null } : roundGroup}
                    collapsed={roundCollapsed}
                    onToggle={roundGroup === roundGroups[roundGroups.length - 1] ? undefined : () => {
                      setExpandedRounds((current) => {
                        const next = new Set(current);
                        if (next.has(roundGroup.round)) next.delete(roundGroup.round);
                        else next.add(roundGroup.round);
                        try {
                          window.sessionStorage.setItem(getExpandedRoundsStorageKey(taskId), JSON.stringify([...next]));
                        } catch {
                          // ignore storage errors
                        }
                        return next;
                      });
                    }}
                  />
                ) : null;
                if (roundCollapsed || roundGroup?.divider === message) {
                  return roundHeader ? <div key={message.id}>{roundHeader}</div> : null;
                }
                const qIdx = userQuestionIndexByMessageIndex.get(msgIndex);
                const bubble = (
                  <MessageBubble
                    message={message}
                    onResend={handleResend}
                    onSchedule={handleScheduleMessage}
                    onInterrupt={handleInterrupt}
                    interruptEnabled={interruptEnabled}
                    interruptPending={interruptPending}
                  />
                );
                if (qIdx == null) {
                  return <div key={message.id} className={roundHeader ? 'space-y-6' : undefined}>{roundHeader}{bubble}</div>;
                }
                return (
                  <div
                    key={message.id}
                    className={roundHeader ? 'space-y-6' : undefined}
                    ref={(el) => {
                      if (el) {
                        questionRefs.current.set(qIdx, el);
                      } else {
                        questionRefs.current.delete(qIdx);
                      }
                    }}
                  >
                    {roundHeader}
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
      <div className="shrink-0 bg-panel px-3 pb-3 pt-2 md:px-4">
        <div className="w-full space-y-2">
          {aiRuntimeStatusText ? (
            <div className="flex flex-wrap gap-2 text-xs text-muted">
              <span className="max-w-full truncate rounded-full bg-border/50 px-2.5 py-1" title={aiRuntimeStatusText}>
                {aiRuntimeStatusText}
              </span>
            </div>
          ) : null}
          {isPersistent ? (
            <div data-testid="persistent-round-bar" className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span className="rounded-full bg-border/50 px-2.5 py-1 font-medium text-ink">
                Round {persistentState?.round ?? 1}
              </span>
              <span className="mr-auto">
                {isRoundSummaryPending
                  ? 'Writing the round summary…'
                  : isRoundIdle
                    ? 'Round ended — sending a message starts a new round.'
                    : 'Persistent task'}
              </span>
              {!persistentState?.roundEndedAt ? (
                <button
                  type="button"
                  onClick={() => void handleEndRound()}
                  disabled={roundActionPending}
                  className="rounded-lg border border-border px-2.5 py-1 font-medium text-ink transition-colors hover:border-[var(--accent)] disabled:opacity-60"
                >
                  End round
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setIsNewRoundDialogOpen(true)}
                disabled={roundActionPending}
                className="rounded-lg border border-border px-2.5 py-1 font-medium text-ink transition-colors hover:border-[var(--accent)] disabled:opacity-60"
              >
                New round
              </button>
            </div>
          ) : null}
          {visibleComposerFeedback ? (
            <InlineNotice variant={visibleComposerFeedback.variant}>
              {visibleComposerFeedback.message}
            </InlineNotice>
          ) : null}
          <MessageInput
            ref={messageInputRef}
            taskId={taskId}
            onSend={handleSend}
            onInsert={(content) => {
              void handleInsert(content);
            }}
            onInterrupt={() => {
              void handleInterrupt();
            }}
            sendDisabled={(!isTaskRunning && !isRoundIdle) || isRoundSummaryPending || interruptPending || restartPending || roundActionPending}
            interruptEnabled={interruptEnabled}
            interruptPending={interruptPending}
            insertEnabled={insertEnabled}
            insertPending={insertPending}
            autoFocus={autoFocusComposer}
          />
        </div>
      </div>
      {chatMenuSlot ? createPortal(
        // Session-wide actions; the message toolbar only acts on its own message.
        <ReadingSettings>
          <button type="button" data-menu-item onClick={handleScheduleDraft} className={CHAT_MENU_ITEM_CLASS_NAME}>
            Schedule
          </button>
          {task && (task.taskType ?? 'ai_task') === 'ai_task' ? (
            <>
              <button type="button" data-menu-item data-testid="chat-menu-restart" disabled={!restartEnabled} onClick={() => void handleRestart()} className={CHAT_MENU_ITEM_CLASS_NAME}>
                {restartPending ? 'Restarting…' : 'Restart'}
              </button>
              <button type="button" data-menu-item onClick={() => setIsPersistentDialogOpen(true)} className={CHAT_MENU_ITEM_CLASS_NAME}>
                Next round
              </button>
            </>
          ) : null}
        </ReadingSettings>,
        chatMenuSlot,
      ) : null}
      {task && isPersistentDialogOpen ? (
        <PersistentTaskSettingsDialog
          task={task}
          open={isPersistentDialogOpen}
          onClose={() => setIsPersistentDialogOpen(false)}
        />
      ) : null}
      {task && isPersistent ? (
        <NewRoundDialog
          task={task}
          open={isNewRoundDialogOpen}
          onClose={() => setIsNewRoundDialogOpen(false)}
          onStartRound={startRound}
        />
      ) : null}
      <ScheduledMessageDialog
        open={scheduledMessage !== null}
        taskId={taskId}
        message={scheduledMessage}
        onClose={() => setScheduledMessage(null)}
        onChanged={refreshScheduledMessageSummary}
      />
    </div>
  );
}

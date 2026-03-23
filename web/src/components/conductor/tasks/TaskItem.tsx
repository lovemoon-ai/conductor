'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Task } from '@/lib/conductor/types';
import { TaskStatusBadge } from './TaskStatusBadge';
import type { TaskListViewMode } from './TaskList';
import { useChatStore } from '@/lib/conductor/stores/chat';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { useRuntimeStore } from '@/lib/conductor/stores/runtime';
import { useConfirm, useToast } from '../common/FeedbackProvider';

interface TaskItemProps {
  task: Task;
  isUnread: boolean;
  isSelected: boolean;
  isActive?: boolean;
  selectionMode: boolean;
  onToggleSelect: (taskId: string) => void;
  onOpenTask?: (taskId: string) => void;
  desktopListPaneMode?: boolean;
  viewMode?: TaskListViewMode;
}

const LEFT_ACTION_WIDTH = 52;
const RIGHT_ACTION_WIDTH = 144;
const SWIPE_OPEN_THRESHOLD = 0.45;
const SWIPE_START_THRESHOLD = 8;
const GRID_DRAFT_STORAGE_PREFIX = 'conductor-grid-task-draft:';
const EMPTY_TASK_MESSAGES: Array<{ id: string; role: string; content: string }> = [];
const AI_POPUP_VIEWPORT_MARGIN_PX = 16;
const AI_POPUP_MAX_WIDTH_PX = 640;
const AI_POPUP_LINE_THRESHOLD = 5;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const getGridDraftStorageKey = (taskId: string) => `${GRID_DRAFT_STORAGE_PREFIX}${taskId}`;

const EditIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>
);

const TrashIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const SelectIcon = ({ selected }: { selected: boolean }) => (
  <svg className="h-3.5 w-3.5" fill={selected ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
  </svg>
);

export function TaskItem({
  task,
  isUnread,
  isSelected,
  isActive = false,
  selectionMode,
  onToggleSelect,
  onOpenTask,
  desktopListPaneMode = false,
  viewMode = 'list',
}: TaskItemProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [gridDraft, setGridDraft] = useState('');
  const [isSendingGridMessage, setIsSendingGridMessage] = useState(false);
  const [gridComposerFeedback, setGridComposerFeedback] = useState<string | null>(null);
  const [optimisticLatestInputText, setOptimisticLatestInputText] = useState<string | null>(
    task.lastUserMessage?.trim() || null,
  );
  const [isAiPopupVisible, setIsAiPopupVisible] = useState(false);
  const [aiPopupStyle, setAiPopupStyle] = useState<CSSProperties | undefined>(undefined);
  const [hidePreviousAssistantReply, setHidePreviousAssistantReply] = useState(false);
  const [suppressedAssistantReply, setSuppressedAssistantReply] = useState<string | null>(null);

  const swipeOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startOffsetRef = useRef(0);
  const didSwipeRef = useRef(false);
  const prevIsSelectedRef = useRef(isSelected);
  const skipGridDraftStoreEffectRef = useRef(true);
  const aiPreviewRef = useRef<HTMLDivElement | null>(null);
  const aiPopupRef = useRef<HTMLDivElement | null>(null);
  const gridCardRef = useRef<HTMLDivElement | null>(null);
  const aiPopupHideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { updateTask, deleteTask, markTaskRead } = useTasksStore();
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const sendMessage = useChatStore((state) => state.sendMessage);
  const taskMessages = useChatStore((state) => state.messagesByTask[task.id] ?? EMPTY_TASK_MESSAGES);
  const runtime = useRuntimeStore((state) => state.byTask[task.id]);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const taskMetadata = task.metadata as Record<string, unknown> | null;
  const launchConfig = task.launchConfig as Record<string, unknown> | null;
  const taskType = task.taskType ?? 'ai_task';
  const backend = task.backendType
    || (typeof taskMetadata?.backendType === 'string' ? taskMetadata.backendType : undefined)
    || (typeof launchConfig?.toolPreset === 'string' ? launchConfig.toolPreset : undefined)
    || runtime?.backend;
  const daemon = (() => {
    const runtimeDaemon = typeof runtime?.daemon === 'string' ? runtime.daemon.trim() : '';
    if (runtimeDaemon) {
      return runtimeDaemon;
    }
    const metadataDaemon = typeof taskMetadata?.daemonName === 'string' ? taskMetadata.daemonName.trim() : '';
    if (metadataDaemon) {
      return metadataDaemon;
    }
    const agentHost = task.executionHost || task.agentHost || undefined;
    return typeof agentHost === 'string' && agentHost.trim() ? agentHost.trim() : undefined;
  })();
  const runtimeText = runtime?.statusLine || runtime?.statusDoneLine || runtime?.replyPreview || runtime?.state || null;
  const latestInputText = task.lastUserMessage?.trim() || null;
  const latestAssistantMessageFromStore = [...taskMessages]
    .reverse()
    .find((message) => message.role !== 'user' && message.content?.trim())
    ?.content
    ?.trim() || null;
  const latestAssistantStatusText = runtime?.statusLine?.trim()
    || runtime?.statusDoneLine?.trim()
    || runtime?.state?.trim()
    || null;
  const rawLatestAssistantContent = runtime?.replyPreview?.trim()
    || latestAssistantMessageFromStore
    || task.lastAssistantMessage?.trim()
    || null;
  const latestAssistantContent = hidePreviousAssistantReply && rawLatestAssistantContent === suppressedAssistantReply
    ? null
    : rawLatestAssistantContent;
  const latestAssistantText = latestAssistantContent || latestAssistantStatusText || 'No AI response yet.';
  const isMessageableTask = taskType !== 'pty_task';
  const isTaskRunning = task.status === 'running';
  const useDesktopListPaneSurface = desktopListPaneMode && viewMode === 'list' && !selectionMode;
  const isHighlighted = isSelected || (!selectionMode && isActive);
  const highlightedCardClassName = useDesktopListPaneSurface
    ? isActive
      ? 'webapp-card-list-pane-active'
      : 'webapp-card-list-pane-idle'
    : isSelected
      ? 'webapp-card-active-strong'
      : isActive
        ? 'webapp-card-active'
        : '';

  const setSwipeOffsetValue = useCallback((value: number) => {
    swipeOffsetRef.current = value;
    setSwipeOffset(value);
  }, []);

  const closeSwipeActions = useCallback(() => {
    setSwipeOffsetValue(0);
    didSwipeRef.current = false;
  }, [setSwipeOffsetValue]);

  useEffect(() => {
    if (prevIsSelectedRef.current && !isSelected) {
      closeSwipeActions();
    }
    prevIsSelectedRef.current = isSelected;
  }, [closeSwipeActions, isSelected]);

  useEffect(() => {
    setGridComposerFeedback(null);
  }, [task.id]);

  useEffect(() => {
    if (isTaskRunning && gridComposerFeedback) {
      setGridComposerFeedback(null);
    }
  }, [gridComposerFeedback, isTaskRunning]);

  useEffect(() => {
    setOptimisticLatestInputText(latestInputText);
  }, [latestInputText]);

  useEffect(() => {
    if (!hidePreviousAssistantReply) {
      return;
    }

    if (rawLatestAssistantContent && rawLatestAssistantContent !== suppressedAssistantReply) {
      setHidePreviousAssistantReply(false);
      setSuppressedAssistantReply(null);
    }
  }, [hidePreviousAssistantReply, rawLatestAssistantContent, suppressedAssistantReply]);

  useEffect(() => (
    () => {
      if (aiPopupHideTimeoutRef.current) {
        clearTimeout(aiPopupHideTimeoutRef.current);
      }
    }
  ), []);

  const showAiPopup = useCallback(() => {
    if (aiPopupHideTimeoutRef.current) {
      clearTimeout(aiPopupHideTimeoutRef.current);
      aiPopupHideTimeoutRef.current = null;
    }
    markTaskRead(task.id);
    setIsAiPopupVisible(true);
  }, [markTaskRead, task.id]);

  const hideAiPopup = useCallback(() => {
    if (aiPopupHideTimeoutRef.current) {
      clearTimeout(aiPopupHideTimeoutRef.current);
    }
    aiPopupHideTimeoutRef.current = setTimeout(() => {
      setIsAiPopupVisible(false);
      aiPopupHideTimeoutRef.current = null;
    }, 80);
  }, []);

  useEffect(() => {
    if (!isAiPopupVisible) {
      return;
    }

    const handleViewportChange = () => {
      const anchor = aiPreviewRef.current;
      const popup = aiPopupRef.current;
      const card = gridCardRef.current;
      if (!anchor || !popup || !card || typeof window === 'undefined') {
        return;
      }

      const anchorRect = anchor.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const popupRect = popup.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const cardWidth = Math.max(280, Math.round(cardRect.width));
      const maxPopupWidth = Math.min(
        AI_POPUP_MAX_WIDTH_PX,
        Math.max(280, viewportWidth - AI_POPUP_VIEWPORT_MARGIN_PX * 2),
      );
      let popupWidth = Math.min(cardWidth, maxPopupWidth);
      if (latestAssistantText) {
        const probe = document.createElement('div');
        probe.style.position = 'fixed';
        probe.style.visibility = 'hidden';
        probe.style.pointerEvents = 'none';
        probe.style.left = '-9999px';
        probe.style.top = '0';
        probe.style.width = `${popupWidth}px`;
        probe.style.padding = '12px';
        probe.style.whiteSpace = 'pre-wrap';
        probe.style.wordBreak = 'break-word';
        probe.style.fontSize = '14px';
        probe.style.lineHeight = '20px';
        probe.textContent = latestAssistantText;
        document.body.appendChild(probe);
        const estimatedLines = Math.ceil(probe.scrollHeight / 20);
        document.body.removeChild(probe);
        if (estimatedLines > AI_POPUP_LINE_THRESHOLD) {
          popupWidth = maxPopupWidth;
        }
      }
      const popupHeight = popupRect.height || 0;

      const maxLeft = viewportWidth - popupWidth - AI_POPUP_VIEWPORT_MARGIN_PX;
      const left = clamp(cardRect.left, AI_POPUP_VIEWPORT_MARGIN_PX, Math.max(AI_POPUP_VIEWPORT_MARGIN_PX, maxLeft));

      const preferredTop = anchorRect.top;
      const maxTop = viewportHeight - popupHeight - AI_POPUP_VIEWPORT_MARGIN_PX;
      const top = clamp(preferredTop, AI_POPUP_VIEWPORT_MARGIN_PX, Math.max(AI_POPUP_VIEWPORT_MARGIN_PX, maxTop));

      setAiPopupStyle({
        position: 'fixed',
        top,
        left,
        width: popupWidth,
      });
    };

    handleViewportChange();
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [isAiPopupVisible, latestAssistantText]);

  useLayoutEffect(() => {
    if (!isAiPopupVisible) {
      return;
    }

    const anchor = aiPreviewRef.current;
    const popup = aiPopupRef.current;
    const card = gridCardRef.current;
    if (!anchor || !popup || !card || typeof window === 'undefined') {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const cardWidth = Math.max(280, Math.round(cardRect.width));
    const maxPopupWidth = Math.min(
      AI_POPUP_MAX_WIDTH_PX,
      Math.max(280, viewportWidth - AI_POPUP_VIEWPORT_MARGIN_PX * 2),
    );
    let popupWidth = Math.min(cardWidth, maxPopupWidth);
    if (latestAssistantText) {
      const probe = document.createElement('div');
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      probe.style.pointerEvents = 'none';
      probe.style.left = '-9999px';
      probe.style.top = '0';
      probe.style.width = `${popupWidth}px`;
      probe.style.padding = '12px';
      probe.style.whiteSpace = 'pre-wrap';
      probe.style.wordBreak = 'break-word';
      probe.style.fontSize = '14px';
      probe.style.lineHeight = '20px';
      probe.textContent = latestAssistantText;
      document.body.appendChild(probe);
      const estimatedLines = Math.ceil(probe.scrollHeight / 20);
      document.body.removeChild(probe);
      if (estimatedLines > AI_POPUP_LINE_THRESHOLD) {
        popupWidth = maxPopupWidth;
      }
    }
    const maxLeft = viewportWidth - popupWidth - AI_POPUP_VIEWPORT_MARGIN_PX;
    const left = clamp(cardRect.left, AI_POPUP_VIEWPORT_MARGIN_PX, Math.max(AI_POPUP_VIEWPORT_MARGIN_PX, maxLeft));
    const maxTop = viewportHeight - popupRect.height - AI_POPUP_VIEWPORT_MARGIN_PX;
    const top = clamp(
      anchorRect.top,
      AI_POPUP_VIEWPORT_MARGIN_PX,
      Math.max(AI_POPUP_VIEWPORT_MARGIN_PX, maxTop),
    );

    setAiPopupStyle({
      position: 'fixed',
      top,
      left,
      width: popupWidth,
    });
  }, [isAiPopupVisible, latestAssistantText]);

  useEffect(() => {
    if (!isAiPopupVisible) {
      return;
    }

    aiPopupRef.current?.focus({ preventScroll: true });
  }, [isAiPopupVisible]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    skipGridDraftStoreEffectRef.current = true;
    try {
      const savedDraft = window.sessionStorage.getItem(getGridDraftStorageKey(task.id));
      setGridDraft(savedDraft ?? '');
    } catch {
      setGridDraft('');
    }
  }, [task.id]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    if (skipGridDraftStoreEffectRef.current) {
      skipGridDraftStoreEffectRef.current = false;
      return;
    }

    try {
      const storageKey = getGridDraftStorageKey(task.id);
      if (!gridDraft) {
        window.sessionStorage.removeItem(storageKey);
        return;
      }
      window.sessionStorage.setItem(storageKey, gridDraft);
    } catch {
    }
  }, [gridDraft, task.id]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (viewMode !== 'list') {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    draggingRef.current = true;
    pointerIdRef.current = event.pointerId;
    startXRef.current = event.clientX;
    startOffsetRef.current = swipeOffsetRef.current;
    didSwipeRef.current = false;
    setIsSwiping(true);

    const target = event.currentTarget;
    if (typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // ignore capture failures
      }
    }
  }, [viewMode]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (viewMode !== 'list') {
      return;
    }
    if (!draggingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }
    const delta = event.clientX - startXRef.current;
    const nextOffset = clamp(startOffsetRef.current + delta, -RIGHT_ACTION_WIDTH, LEFT_ACTION_WIDTH);
    if (Math.abs(nextOffset - startOffsetRef.current) > SWIPE_START_THRESHOLD) {
      didSwipeRef.current = true;
    }
    setSwipeOffsetValue(nextOffset);
  }, [setSwipeOffsetValue, viewMode]);

  const finalizeSwipe = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (viewMode !== 'list') {
      return;
    }
    if (!draggingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }
    draggingRef.current = false;
    setIsSwiping(false);

    const currentOffset = swipeOffsetRef.current;
    let targetOffset = 0;
    if (currentOffset >= LEFT_ACTION_WIDTH * SWIPE_OPEN_THRESHOLD) {
      targetOffset = LEFT_ACTION_WIDTH;
    } else if (currentOffset <= -RIGHT_ACTION_WIDTH * SWIPE_OPEN_THRESHOLD) {
      targetOffset = -RIGHT_ACTION_WIDTH;
    }
    setSwipeOffsetValue(targetOffset);
    pointerIdRef.current = null;

    const target = event.currentTarget;
    if (typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  }, [setSwipeOffsetValue, viewMode]);

  const consumeTap = useCallback(() => {
    if (viewMode !== 'list') {
      return false;
    }
    if (didSwipeRef.current) {
      didSwipeRef.current = false;
      return true;
    }
    if (swipeOffsetRef.current !== 0) {
      closeSwipeActions();
      return true;
    }
    return false;
  }, [closeSwipeActions, viewMode]);

  const openTaskDetail = () => {
    if (selectionMode) {
      onToggleSelect(task.id);
      return;
    }
    markTaskRead(task.id);
    if (onOpenTask) {
      onOpenTask(task.id);
      return;
    }
    router.push(`/app/tasks/${task.id}`);
  };

  const handleRename = async () => {
    if (editTitle.trim() && editTitle !== task.title) {
      await updateTask(task.id, { title: editTitle.trim() });
    }
    setIsEditing(false);
    closeSwipeActions();
  };

  const handleDelete = async () => {
    const accepted = await confirm({
      title: 'Delete this task?',
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) {
      return;
    }

    try {
      await deleteTask(task.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete task';
      pushToast({
        title: 'Failed to delete task',
        description: message,
        variant: 'error',
      });
    } finally {
      closeSwipeActions();
    }
  };

  const handleGridSend = async () => {
    const content = gridDraft.trim();
    if (!content || isSendingGridMessage) {
      return;
    }

    if (!isMessageableTask) {
      setGridComposerFeedback('PTY task does not accept chat input. Open the task detail to use the terminal.');
      return;
    }

    if (!isTaskRunning) {
      setGridComposerFeedback(
        task.status === 'completed'
          ? 'This task is already completed. Start a new run before sending more messages.'
          : task.status === 'killed'
            ? 'This task has stopped. Restart it before sending more messages.'
            : 'The session is still starting. You can keep drafting, and send once the task is ready.',
      );
      return;
    }

    try {
      setIsSendingGridMessage(true);
      setGridComposerFeedback(null);
      setHidePreviousAssistantReply(true);
      setSuppressedAssistantReply(rawLatestAssistantContent);
      clearRuntime(task.id);
      await sendMessage(task.id, { content, role: 'user' });
      setOptimisticLatestInputText(content);
      setGridDraft('');
    } catch {
      const message = 'Failed to send the message. Please try again in a moment.';
      setGridComposerFeedback(message);
      pushToast({
        title: 'Message send failed',
        description: message,
        variant: 'error',
      });
      setHidePreviousAssistantReply(false);
      setSuppressedAssistantReply(null);
    } finally {
      setIsSendingGridMessage(false);
    }
  };

  const isLeftActionsOpen = swipeOffset > 0;
  const isRightActionsOpen = swipeOffset < 0;
  const cardStyle = useMemo<CSSProperties>(() => ({
    transform: `translateX(${swipeOffset}px)`,
    transition: isSwiping ? 'none' : 'transform 180ms ease',
    touchAction: 'pan-y',
  }), [isSwiping, swipeOffset]);

  const metadataChips = (
    <>
      <span
        className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${
          taskType === 'pty_task'
            ? 'bg-[var(--ink)] text-[var(--paper)]'
            : 'bg-[var(--paper)] text-muted'
        }`}
      >
        {taskType === 'pty_task' ? 'PTY' : 'AI'}
      </span>
      {backend ? (
        <span className="flex items-center gap-1 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
          {backend}
        </span>
      ) : null}
      {daemon ? (
        <span className="flex items-center gap-1 rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted">
          {daemon}
        </span>
      ) : null}
    </>
  );

  if (isEditing) {
    return (
      <div className="webapp-card p-4">
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={() => void handleRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleRename();
            if (e.key === 'Escape') setIsEditing(false);
          }}
          className="webapp-input w-full text-base font-medium"
          autoFocus
        />
      </div>
    );
  }

  if (viewMode === 'grid') {
    const defaultGridComposerPlaceholder = !isMessageableTask
      ? 'Open task detail to use the terminal...'
      : task.status === 'completed'
        ? 'This task is completed...'
        : task.status === 'killed'
          ? 'This task has stopped...'
          : 'Type a message...';
    const gridComposerPlaceholder = optimisticLatestInputText || defaultGridComposerPlaceholder;
    const canSendGridMessage = Boolean(gridDraft.trim()) && isMessageableTask && isTaskRunning && !isSendingGridMessage;

    return (
      <div
        ref={gridCardRef}
        className={`webapp-card flex h-full min-w-0 w-full max-w-full flex-col overflow-hidden p-4 transition-colors hover:border-[var(--accent)] ${
          isHighlighted ? highlightedCardClassName : ''
        }`}
        role="button"
        tabIndex={0}
        onClick={openTaskDetail}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openTaskDetail();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isUnread ? <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)] animate-pulse" /> : null}
              <h3 className="truncate text-base font-semibold text-ink">{task.title}</h3>
            </div>
          </div>
          <TaskStatusBadge status={task.status} />
        </div>

        <div className="mt-4 flex flex-wrap gap-2 text-sm text-muted">
          {metadataChips}
        </div>

        <div className="mt-4 flex flex-1 flex-col rounded-2xl border border-border/60 bg-paper/55">
          <div
            className="flex min-h-[112px] flex-1 flex-col px-4 pb-1 pt-2.5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[11px] text-muted">
                {latestAssistantStatusText || 'Last AI'}
              </p>
              {runtime?.replyInProgress ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] font-medium text-[var(--accent)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                  Live
                </span>
              ) : null}
            </div>
            <div
              ref={aiPreviewRef}
              className="relative mt-0.5 flex-1"
              onMouseEnter={showAiPopup}
              onMouseLeave={hideAiPopup}
            >
              <p className="line-clamp-2 text-sm text-ink/90">
                {latestAssistantText || 'No AI response yet.'}
              </p>
              {isAiPopupVisible && latestAssistantText ? (
                <div
                  ref={aiPopupRef}
                  tabIndex={-1}
                  style={aiPopupStyle}
                  className="webapp-card webapp-scrollbar z-30 max-h-[min(32rem,calc(100vh-2rem))] overflow-y-auto p-3 text-sm text-ink outline-none"
                  onMouseEnter={showAiPopup}
                  onMouseLeave={hideAiPopup}
                  onFocus={showAiPopup}
                  onBlur={(e) => {
                    const nextTarget = e.relatedTarget as Node | null;
                    if (
                      nextTarget
                      && (aiPopupRef.current?.contains(nextTarget) || aiPreviewRef.current?.contains(nextTarget))
                    ) {
                      return;
                    }
                    hideAiPopup();
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <p className="whitespace-pre-wrap break-words text-sm text-ink/95">
                    {latestAssistantText}
                  </p>
                </div>
              ) : null}
            </div>
          </div>

          <div className="relative z-10 mx-4 border-t border-zinc-300/80 dark:border-zinc-700/80" />

          <div className="flex flex-col px-4 pb-2 pt-0.5" onClick={(e) => e.stopPropagation()}>
            <div className="mt-0">
              <div className="flex items-center gap-2">
                <textarea
                  value={gridDraft}
                  onChange={(e) => setGridDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                      e.preventDefault();
                      void handleGridSend();
                    }
                  }}
                  placeholder={gridComposerPlaceholder}
                  disabled={!isMessageableTask || isSendingGridMessage}
                  rows={1}
                  className="h-6 min-w-0 flex-1 resize-none border-0 bg-transparent p-0 text-sm text-ink/90 outline-none placeholder:text-muted disabled:cursor-not-allowed disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleGridSend();
                  }}
                  disabled={!canSendGridMessage}
                  aria-label={isSendingGridMessage ? 'Sending message' : 'Send message'}
                  title={isSendingGridMessage ? 'Sending message' : 'Send message'}
                  className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 webapp-gradient-bg text-white"
                >
                  <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <path d="M4 3l12 7-12 7V3z" />
                  </svg>
                </button>
              </div>
              {gridComposerFeedback ? (
                <p className="mt-2 text-[11px] text-muted">{gridComposerFeedback}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div className="absolute inset-y-0 left-0 z-0 flex w-[52px] items-center justify-center" aria-hidden={!isLeftActionsOpen}>
        <button
          type="button"
          tabIndex={isLeftActionsOpen ? 0 : -1}
          aria-label={isSelected ? 'Deselect task' : 'Select task'}
          title={isSelected ? 'Deselect' : 'Select'}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const shouldCloseAfterToggle = isSelected;
            onToggleSelect(task.id);
            if (shouldCloseAfterToggle) {
              closeSwipeActions();
            }
          }}
          className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
            isSelected
              ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
              : 'border-border bg-[var(--paper)] text-muted hover:border-[var(--accent)] hover:text-[var(--accent)]'
          }`}
        >
          <SelectIcon selected={isSelected} />
        </button>
      </div>

      <div className="absolute inset-y-0 right-0 z-0 flex" aria-hidden={!isRightActionsOpen}>
        <button
          type="button"
          tabIndex={isRightActionsOpen ? 0 : -1}
          aria-label="Rename task"
          title="Rename"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setIsEditing(true);
            closeSwipeActions();
          }}
          className="flex h-full w-[72px] items-center justify-center border-l border-border bg-[var(--paper)] text-muted transition-colors hover:text-ink"
        >
          <EditIcon />
        </button>
        <button
          type="button"
          tabIndex={isRightActionsOpen ? 0 : -1}
          aria-label="Delete task"
          title="Delete"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void handleDelete();
          }}
          className="flex h-full w-[72px] items-center justify-center border-l border-border bg-[var(--error)]/10 text-[var(--error)] transition-colors hover:bg-[var(--error)]/20"
        >
          <TrashIcon />
        </button>
      </div>

      <div
        onClick={() => {
          if (consumeTap()) {
            return;
          }
          openTaskDetail();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finalizeSwipe}
        onPointerCancel={finalizeSwipe}
        style={cardStyle}
        className={`webapp-card relative z-10 cursor-pointer p-4 transition-colors hover:border-[var(--accent)] ${
          useDesktopListPaneSurface || isHighlighted ? highlightedCardClassName : ''
        }`}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            closeSwipeActions();
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (swipeOffsetRef.current !== 0) {
              closeSwipeActions();
              return;
            }
            openTaskDetail();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isUnread ? <span className="h-2 w-2 shrink-0 rounded-full bg-[var(--accent)] animate-pulse" /> : null}
              <h3 className="truncate text-base font-medium text-ink">{task.title}</h3>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
              {metadataChips}
            </div>
            {runtimeText ? (
              <p className="mt-3 line-clamp-2 text-sm text-muted/90">
                {runtimeText}
              </p>
            ) : null}
          </div>
          <TaskStatusBadge status={task.status} />
        </div>
      </div>
    </div>
  );
}

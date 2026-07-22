'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Header, type TitleSwipeProgress } from '@/components/layout/Header';
import { ChatView } from '@/features/chat';
import { TerminalView } from '@/features/terminal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { getApiClient } from '@/shared/api/client';
import type { Task } from '@/shared/types';
import { normalizeTask, useTasksStore } from '../store';
import { usePtyToggleStore } from '../pty-toggle-store';

interface TaskDetailPaneProps {
  taskId: string;
  showBack?: boolean;
  onBack?: () => void;
  compactHeader?: boolean;
  showConnectionStatus?: boolean;
  hideHeader?: boolean;
  onTitleSwipeLeft?: () => void;
  onTitleSwipeRight?: () => void;
  onTitleSwipeProgress?: (state: TitleSwipeProgress) => void;
  titleSwipePreviewLeft?: string | null;
  titleSwipePreviewRight?: string | null;
  titleTransitionDirection?: 'forward' | 'backward' | null;
  titleSwipeState?: Pick<TitleSwipeProgress, 'progress' | 'isDragging'>;
}

const TASK_SWIPE_CONTENT_OFFSET_PX = 14;
const TASK_SWIPE_CONTENT_MAX_OPACITY_DROP = 0.16;

export function TaskDetailPane({
  taskId,
  showBack = false,
  onBack,
  compactHeader = false,
  showConnectionStatus = false,
  hideHeader = false,
  onTitleSwipeLeft,
  onTitleSwipeRight,
  onTitleSwipeProgress,
  titleSwipePreviewLeft,
  titleSwipePreviewRight,
  titleTransitionDirection,
  titleSwipeState,
}: TaskDetailPaneProps) {
  const { tasks, fetchTask, markTaskRead } = useTasksStore();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const task = tasks.find((item) => item.id === taskId);
  const taskExistsRef = useRef(false);
  taskExistsRef.current = Boolean(task);

  useEffect(() => {
    let cancelled = false;

    if (!taskId) {
      return () => {
        cancelled = true;
      };
    }

    markTaskRead(taskId);
    const shouldBlock = !taskExistsRef.current;
    if (shouldBlock) {
      setPendingTaskId(taskId);
    }

    void fetchTask(taskId).finally(() => {
      if (!cancelled && shouldBlock) {
        setPendingTaskId((current) => (current === taskId ? null : current));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [fetchTask, markTaskRead, taskId]);

  // Visibility flag and attached PTY hydration are scoped to AI tasks.
  // We hydrate the PTY task into local state (rather than into useTasksStore)
  // because the top-level task list endpoint deliberately filters attached
  // PTY tasks out — adding them to the shared store would re-introduce them
  // and conflict with the list-level filtering.
  const isAiTask = (task?.taskType ?? 'ai_task') === 'ai_task';
  const attachedPtyTaskId =
    isAiTask && task?.attachedTerminal ? task.attachedTerminal.ptyTaskId : null;
  const ptyActive = usePtyToggleStore((s) =>
    isAiTask && task ? Boolean(s.byAiTaskId[task.id]) : false,
  );
  const hydratePtyToggle = usePtyToggleStore((s) => s.hydrate);
  // SSR safety: the persisted toggle state lives in localStorage. The store
  // initialises empty on both client and server; we lift the persisted value
  // into state here, post-mount, so the first render matches the server HTML.
  useEffect(() => {
    hydratePtyToggle();
  }, [hydratePtyToggle]);

  // `attachedPtyFetchState` is "idle" when no fetch needed, "loading" while
  // hydrating, "ready" when we have the PTY task, "missing" when the GET
  // returned 404 (the row was deleted out from under us). We use "missing"
  // to render an explicit empty state instead of silently falling back to
  // ChatView — the chip is showing PTY-active and the user expects a
  // terminal, so they need feedback that it's gone.
  const [attachedPtyTask, setAttachedPtyTask] = useState<Task | null>(null);
  const [attachedPtyFetchState, setAttachedPtyFetchState] = useState<
    'idle' | 'loading' | 'ready' | 'missing'
  >('idle');

  useEffect(() => {
    if (!ptyActive || !attachedPtyTaskId) {
      setAttachedPtyTask(null);
      setAttachedPtyFetchState('idle');
      return;
    }
    let cancelled = false;
    setAttachedPtyFetchState('loading');
    const api = getApiClient();
    api
      .get<Task>(`/tasks/${attachedPtyTaskId}`)
      .then((raw) => {
        if (cancelled) return;
        setAttachedPtyTask(normalizeTask(raw));
        setAttachedPtyFetchState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setAttachedPtyTask(null);
        setAttachedPtyFetchState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [attachedPtyTaskId, ptyActive]);

  if (!task && pendingTaskId === taskId) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (!task) {
    return (
      <>
        {!hideHeader ? (
          <Header
            title="Task Not Found"
            showBack={showBack}
            onBack={onBack}
            compact={compactHeader}
          />
        ) : null}
        <div className="flex flex-1 items-center justify-center px-6 text-center text-muted">
          <p>This task does not exist or has been deleted.</p>
        </div>
      </>
    );
  }

  // For an AI task whose attached terminal toggle is "on" and whose PTY task
  // has been hydrated, render the terminal view instead of chat. The
  // <ChatView /> is intentionally NOT also mounted in the background — that
  // matches the product spec (mutex switch) and avoids paying the cost of
  // keeping two heavy panels alive.
  //
  // We also require a live `attachedPtyTaskId` (not just the stale local
  // `attachedPtyTask` ref) so that the instant the owning AI task's
  // `attachedTerminal` clears (e.g., after deleting the PTY from
  // TerminalView's toolbar), the next render swings to chat WITHOUT briefly
  // re-rendering TerminalView against a deleted task on the way through.
  const showAttachedTerminal =
    isAiTask && ptyActive && Boolean(attachedPtyTaskId) && attachedPtyTask !== null;
  // If toggle is on but the PTY row vanished (deleted by another client or
  // by an explicit DELETE on the PTY task id), render an explicit empty
  // state. Falling back silently to ChatView would surprise the user who is
  // looking at a green PTY chip and expecting a terminal.
  const showAttachedTerminalMissing =
    isAiTask && ptyActive && attachedPtyTaskId && attachedPtyFetchState === 'missing';
  const titleSwipeProgress = titleSwipeState?.progress ?? 0;
  const contentTransitionClassName = titleTransitionDirection
    ? `webapp-task-detail-switch-${titleTransitionDirection}`
    : '';
  const contentSwipeClassName = titleSwipeState
    ? `webapp-task-detail-swipe-follow ${
        titleSwipeState.isDragging ? 'webapp-task-detail-swipe-follow-dragging' : ''
      }`
    : '';
  const contentSwipeStyle: CSSProperties | undefined = titleSwipeProgress !== 0
    ? {
        opacity: 1 - Math.min(
          Math.abs(titleSwipeProgress) * TASK_SWIPE_CONTENT_MAX_OPACITY_DROP,
          TASK_SWIPE_CONTENT_MAX_OPACITY_DROP,
        ),
        transform: `translateX(${titleSwipeProgress * TASK_SWIPE_CONTENT_OFFSET_PX}px)`,
      }
    : undefined;

  return (
    <>
      {!hideHeader ? (
        <Header
          title={task.title}
          showBack={showBack}
          onBack={onBack}
          showConnectionStatus={showConnectionStatus}
          compact={compactHeader}
          connectionTaskId={taskId}
          onTitleSwipeLeft={onTitleSwipeLeft}
          onTitleSwipeRight={onTitleSwipeRight}
          onTitleSwipeProgress={onTitleSwipeProgress}
          titleSwipePreviewLeft={titleSwipePreviewLeft}
          titleSwipePreviewRight={titleSwipePreviewRight}
          titleTransitionDirection={titleTransitionDirection}
        />
      ) : null}
      <div
        className={`min-h-0 flex-1 overflow-hidden ${contentTransitionClassName} ${contentSwipeClassName}`}
        style={contentSwipeStyle}
      >
        {task.taskType === 'pty_task' ? (
          <TerminalView task={task} />
        ) : showAttachedTerminal ? (
          <TerminalView task={attachedPtyTask!} />
        ) : showAttachedTerminalMissing ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted">
            <p className="text-base font-medium text-ink">Terminal unavailable</p>
            <p className="text-sm">
              The attached terminal has been removed. Use the PTY chip on this task
              to delete the stale binding, or attach a new terminal from the
              left-swipe menu.
            </p>
          </div>
        ) : (
          <ChatView taskId={taskId} autoFocusComposer={hideHeader} />
        )}
      </div>
    </>
  );
}

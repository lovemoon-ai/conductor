'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Task } from '@/shared/types';
import { TaskStatusBadge } from './TaskStatusBadge';
import { RestartTaskControls } from './RestartTaskControls';
import { useTasksStore } from '../store';
import { useRuntimeStore } from '@/features/realtime';
import { getApiClient } from '@/shared/api/client';
import { Dialog } from '@/components/common/Dialog';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';

interface TaskItemProps {
  task: Task;
  isUnread: boolean;
  isSelected: boolean;
  isActive?: boolean;
  selectionMode: boolean;
  onToggleSelect: (taskId: string) => void;
  onOpenTask?: (taskId: string) => void;
  desktopListPaneMode?: boolean;
  showProjectInfo?: boolean;
  projectName?: string | null;
  projectDaemonHost?: string | null;
}

interface ShareDialogState {
  title: string;
  shareUrl: string;
  aiShareUrl: string;
}

const LEFT_ACTION_WIDTH = 52;
const RIGHT_ACTION_BUTTON_WIDTH = 72;
const SWIPE_OPEN_THRESHOLD = 0.45;
const SWIPE_START_THRESHOLD = 8;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const copyToClipboard = async (value: string): Promise<boolean> => {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return true;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-1000px';
  textarea.style.left = '-1000px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
};
const isInteractiveTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && Boolean(target.closest('button, input, textarea, select, a, summary'));
const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
};
const normalizeBoolean = (value: unknown): boolean => {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};
const parseTaskWorktreeBranch = (
  task: Pick<Task, 'taskType' | 'launchConfig'>,
): string | null => {
  if (task.taskType === 'pty_task') {
    return null;
  }
  const launchConfig =
    task.launchConfig && typeof task.launchConfig === 'object' && !Array.isArray(task.launchConfig)
      ? task.launchConfig
      : null;
  if (!launchConfig) {
    return null;
  }
  const requested = normalizeBoolean(
    launchConfig.worktree ??
      launchConfig.createWorktree ??
      launchConfig.create_worktree,
  );
  if (!requested) {
    return null;
  }
  return (
    normalizeOptionalString(launchConfig.worktreeBranch) ??
    normalizeOptionalString(launchConfig.worktree_branch)
  );
};

const TrashIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const NewTaskIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <circle cx="7" cy="6" r="2.5" strokeWidth={2} />
    <circle cx="7" cy="18" r="2.5" strokeWidth={2} />
    <circle cx="17" cy="8" r="2.5" strokeWidth={2} />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8.5v7" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.5 6H12a5 5 0 015 5" />
  </svg>
);

const ShareIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M12 16V5m0 0l-4 4m4-4l4 4M5 13v3a3 3 0 003 3h8a3 3 0 003-3v-3"
    />
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
  showProjectInfo = false,
  projectName = null,
  projectDaemonHost = null,
}: TaskItemProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [isRestartDialogOpen, setIsRestartDialogOpen] = useState(false);
  const [isKillConfirming, setIsKillConfirming] = useState(false);
  const [isKillingTask, setIsKillingTask] = useState(false);
  const [isRestartConfirming, setIsRestartConfirming] = useState(false);
  const [isRestartingTask, setIsRestartingTask] = useState(false);
  const [editTitle, setEditTitle] = useState(task.title);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartXRef = useRef(0);
  const longPressStartYRef = useRef(0);
  const longPressFiredRef = useRef(false);
  const renamingRef = useRef(false);
  const swipeOffsetRef = useRef(0);
  const draggingRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const startXRef = useRef(0);
  const startOffsetRef = useRef(0);
  const didSwipeRef = useRef(false);
  const dismissedStatusConfirmationRef = useRef(false);
  const dismissedStatusConfirmationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevIsSelectedRef = useRef(isSelected);
  const statusBadgeRef = useRef<HTMLDivElement | null>(null);

  const { updateTask, restartTask, deleteTask, markTaskRead } = useTasksStore();
  const { confirm } = useConfirm();
  const { pushToast } = useToast();

  const runtime = useRuntimeStore((state) => state.byTask[task.id]);
  const clearRuntime = useRuntimeStore((state) => state.clearTask);
  const taskMetadata = task.metadata as Record<string, unknown> | null;
  const launchConfig = task.launchConfig as Record<string, unknown> | null;
  const taskType = task.taskType ?? 'ai_task';
  const worktreeBranch = parseTaskWorktreeBranch(task);
  const showRestartAction = taskType === 'ai_task';
  const showShareAction = taskType === 'ai_task';
  const rightActionWidth = RIGHT_ACTION_BUTTON_WIDTH * (
    1 +
    (showRestartAction ? 1 : 0) +
    (showShareAction ? 1 : 0)
  );
  const backend = task.backendType
    || (typeof taskMetadata?.backendType === 'string' ? taskMetadata.backendType : undefined)
    || (typeof launchConfig?.toolPreset === 'string' ? launchConfig.toolPreset : undefined)
    || runtime?.backend;
  const runtimeText = runtime?.statusLine || runtime?.statusDoneLine || runtime?.replyPreview || runtime?.state || null;

  const isTaskRunning = task.status === 'running';
  const canQuickRestart =
    taskType === 'ai_task' &&
    (task.status === 'completed' || task.status === 'killed' || task.status === 'unknown');
  const useDesktopListPaneSurface = desktopListPaneMode && !selectionMode;
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
    if (task.status === 'running') {
      setIsRestartConfirming(false);
      setIsRestartingTask(false);
    } else {
      setIsKillConfirming(false);
      setIsKillingTask(false);
    }
    if (!canQuickRestart) {
      setIsRestartConfirming(false);
      setIsRestartingTask(false);
    }
  }, [canQuickRestart, task.status]);

  useEffect(() => {
    if ((!isKillConfirming && !isRestartConfirming) || typeof document === 'undefined') {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const badgeElement = statusBadgeRef.current;
      if (badgeElement?.contains(event.target as Node | null)) {
        return;
      }
      dismissedStatusConfirmationRef.current = true;
      if (dismissedStatusConfirmationTimeoutRef.current) {
        clearTimeout(dismissedStatusConfirmationTimeoutRef.current);
      }
      dismissedStatusConfirmationTimeoutRef.current = setTimeout(() => {
        dismissedStatusConfirmationRef.current = false;
        dismissedStatusConfirmationTimeoutRef.current = null;
      }, 0);
      setIsKillConfirming(false);
      setIsRestartConfirming(false);
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [isKillConfirming, isRestartConfirming]);

  useEffect(() => (
    () => {
      if (dismissedStatusConfirmationTimeoutRef.current) {
        clearTimeout(dismissedStatusConfirmationTimeoutRef.current);
      }
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
      }
    }
  ), []);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) {
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
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }
    const delta = event.clientX - startXRef.current;
    const nextOffset = clamp(startOffsetRef.current + delta, -rightActionWidth, LEFT_ACTION_WIDTH);
    if (Math.abs(nextOffset - startOffsetRef.current) > SWIPE_START_THRESHOLD) {
      didSwipeRef.current = true;
      clearLongPress();
    }
    setSwipeOffsetValue(nextOffset);
  }, [clearLongPress, setSwipeOffsetValue]);

  const finalizeSwipe = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || pointerIdRef.current !== event.pointerId) {
      return;
    }
    draggingRef.current = false;
    setIsSwiping(false);

    const currentOffset = swipeOffsetRef.current;
    let targetOffset = 0;
    if (currentOffset >= LEFT_ACTION_WIDTH * SWIPE_OPEN_THRESHOLD) {
      targetOffset = LEFT_ACTION_WIDTH;
    } else if (currentOffset <= -rightActionWidth * SWIPE_OPEN_THRESHOLD) {
      targetOffset = -rightActionWidth;
    }
    setSwipeOffsetValue(targetOffset);
    pointerIdRef.current = null;

    const target = event.currentTarget;
    if (typeof target.hasPointerCapture === 'function' && target.hasPointerCapture(event.pointerId)) {
      target.releasePointerCapture(event.pointerId);
    }
  }, [setSwipeOffsetValue]);

  const consumeTap = useCallback(() => {
    if (dismissedStatusConfirmationRef.current) {
      dismissedStatusConfirmationRef.current = false;
      return true;
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
  }, [closeSwipeActions]);

  const handleTitlePointerDown = useCallback((e: ReactPointerEvent<HTMLHeadingElement>) => {
    if (selectionMode) {
      return;
    }
    clearLongPress();
    longPressStartXRef.current = e.clientX;
    longPressStartYRef.current = e.clientY;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      setEditTitle(task.title);
      setIsEditing(true);
    }, 500);
  }, [clearLongPress, selectionMode, task.title]);

  const handleTitlePointerUp = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleTitlePointerMove = useCallback((e: ReactPointerEvent<HTMLHeadingElement>) => {
    if (!longPressTimerRef.current) {
      return;
    }
    const dx = e.clientX - longPressStartXRef.current;
    const dy = e.clientY - longPressStartYRef.current;
    if (dx * dx + dy * dy > 100) {
      clearLongPress();
    }
  }, [clearLongPress]);

  const openTaskPage = useCallback(() => {
    markTaskRead(task.id);
    router.push(`/app/tasks/${task.id}`);
  }, [markTaskRead, router, task.id]);

  const openTaskDetail = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    if (isEditing) {
      return;
    }
    if (dismissedStatusConfirmationRef.current) {
      dismissedStatusConfirmationRef.current = false;
      return;
    }
    if (selectionMode) {
      onToggleSelect(task.id);
      return;
    }
    markTaskRead(task.id);
    if (onOpenTask) {
      onOpenTask(task.id);
      return;
    }
    openTaskPage();
  };

  const handleRename = async () => {
    if (renamingRef.current) {
      return;
    }
    renamingRef.current = true;
    try {
      if (editTitle.trim() && editTitle !== task.title) {
        await updateTask(task.id, { title: editTitle.trim() });
      }
    } finally {
      setIsEditing(false);
      renamingRef.current = false;
    }
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

  const handleShare = async () => {
    const accepted = await confirm({
      title: 'Share this conversation?',
      description: 'Anyone with the link can view all messages in this task without logging in. The link expires in 7 days.',
      confirmLabel: 'Share',
    });
    if (!accepted) {
      closeSwipeActions();
      return;
    }

    try {
      const api = getApiClient();
      const { token } = await api.post<{ token: string }>(`/tasks/${task.id}/share`);
      const url = `${window.location.origin}/share/${token}`;
      const aiUrl = `${url}/plain`;
      try {
        const copied = await copyToClipboard(url);
        if (!copied) {
          throw new Error('copy_failed');
        }
        pushToast({ title: 'Link copied', description: 'Share link copied to clipboard.', variant: 'success' });
      } catch {
        pushToast({ title: 'Link created', description: url, variant: 'success' });
      }
      setShareDialog({
        title: task.title,
        shareUrl: url,
        aiShareUrl: aiUrl,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create share link';
      pushToast({ title: 'Share failed', description: message, variant: 'error' });
    } finally {
      closeSwipeActions();
    }
  };

  const handleCopyShareDialogLink = useCallback(async (value: string) => {
    const copied = await copyToClipboard(value).catch(() => false);
    pushToast({
      title: copied ? 'Link copied' : 'Copy failed',
      description: copied ? value : undefined,
      variant: copied ? 'success' : 'error',
    });
  }, [pushToast]);

  const handleRunningStatusClick = async () => {
    if (!isTaskRunning || isKillingTask || isRestartingTask) {
      return;
    }

    if (!isKillConfirming) {
      setIsRestartConfirming(false);
      setIsKillConfirming(true);
      return;
    }

    try {
      setIsKillingTask(true);
      await updateTask(task.id, { status: 'killed' });
      clearRuntime(task.id);
      setIsKillConfirming(false);
      closeSwipeActions();
    } catch (error) {
      setIsKillConfirming(false);
      pushToast({
        title: 'Failed to kill task',
        description: error instanceof Error ? error.message : 'Please try again in a moment.',
        variant: 'error',
      });
    } finally {
      setIsKillingTask(false);
    }
  };

  const handleStoppedStatusClick = async () => {
    if (!canQuickRestart || isRestartingTask || isKillingTask) {
      return;
    }

    if (!isRestartConfirming) {
      setIsKillConfirming(false);
      setIsRestartConfirming(true);
      return;
    }

    try {
      setIsRestartingTask(true);
      const result = await restartTask(task.id, {
        strategy: 'inplace',
      });
      if (result.mode === 'inplace_restart') {
        clearRuntime(task.id);
      }
      setIsRestartConfirming(false);
      closeSwipeActions();
    } catch (error) {
      setIsRestartConfirming(false);
      pushToast({
        title: 'Failed to restart task',
        description: error instanceof Error ? error.message : 'Please try again in a moment.',
        variant: 'error',
      });
    } finally {
      setIsRestartingTask(false);
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
      {worktreeBranch ? (
        <span
          title={worktreeBranch}
          className="max-w-[11rem] truncate rounded bg-[var(--paper)] px-1.5 py-0.5 font-mono text-xs font-medium text-ink"
        >
          {worktreeBranch}
        </span>
      ) : null}
      {showProjectInfo && projectName ? (
        <span
          title={projectName}
          className="flex max-w-[10rem] items-center gap-1 truncate rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted"
        >
          {projectName}
        </span>
      ) : null}
      {showProjectInfo && projectDaemonHost ? (
        <span
          title={projectDaemonHost}
          className="flex max-w-[10rem] items-center gap-1 truncate rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted"
        >
          {projectDaemonHost}
        </span>
      ) : null}
    </>
  );
  const statusBadgeLabel = isKillingTask
    ? 'killing...'
    : isKillConfirming
      ? 'killing?'
      : isRestartingTask
        ? 'restarting...'
        : isRestartConfirming
          ? 'restart?'
          : undefined;
  const statusBadgeTitle = isTaskRunning
    ? isKillConfirming
      ? 'Click again to kill task'
      : 'Click to confirm kill'
    : canQuickRestart
      ? isRestartConfirming
        ? 'Click again to restart task'
        : 'Click to confirm restart'
      : undefined;
  const statusBadgeProps: {
    onClick?: () => void;
    disabled?: boolean;
    labelOverride?: string;
    title?: string;
    tone?: 'default' | 'danger' | 'warning';
  } = isTaskRunning
    ? {
        onClick: handleRunningStatusClick,
        disabled: isKillingTask,
        labelOverride: statusBadgeLabel,
        title: statusBadgeTitle,
        tone: isKillConfirming || isKillingTask ? 'danger' : 'default',
      }
    : canQuickRestart
      ? {
          onClick: handleStoppedStatusClick,
          disabled: isRestartingTask,
          labelOverride: statusBadgeLabel,
          title: statusBadgeTitle,
          tone: isRestartConfirming ? 'warning' : 'default',
        }
      : {};

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
        {showRestartAction ? (
          <button
            type="button"
            tabIndex={isRightActionsOpen ? 0 : -1}
            aria-label="New task"
            title="New task"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setIsRestartDialogOpen(true);
              closeSwipeActions();
            }}
            className="flex h-full w-[72px] items-center justify-center border-l border-border bg-[var(--paper)] text-muted transition-colors hover:text-ink"
          >
            <NewTaskIcon />
          </button>
        ) : null}
        {showShareAction ? (
          <button
            type="button"
            tabIndex={isRightActionsOpen ? 0 : -1}
            aria-label="Share task"
            title="Share"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleShare();
            }}
            className="flex h-full w-[72px] items-center justify-center border-l border-border bg-[var(--paper)] text-muted transition-colors hover:text-ink"
          >
            <ShareIcon />
          </button>
        ) : null}
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
        onDoubleClick={(e) => {
          e.preventDefault();
          if (isEditing) {
            return;
          }
          if (consumeTap()) {
            return;
          }
          if (selectionMode || !desktopListPaneMode) {
            return;
          }
          openTaskPage();
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
              {isEditing ? (
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => void handleRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') void handleRename();
                    if (e.key === 'Escape') setIsEditing(false);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent text-base font-medium text-ink outline-none ring-1 ring-[var(--accent)] rounded px-1 -mx-1"
                  autoFocus
                />
              ) : (
                <h3
                  className="truncate text-base font-medium text-ink select-none"
                  onPointerDown={handleTitlePointerDown}
                  onPointerUp={handleTitlePointerUp}
                  onPointerMove={handleTitlePointerMove}
                  onPointerCancel={handleTitlePointerUp}
                >
                  {task.title}
                </h3>
              )}
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
          <div ref={statusBadgeRef}>
            <TaskStatusBadge status={task.status} {...statusBadgeProps} />
          </div>
        </div>
      </div>
      {showRestartAction ? (
        <RestartTaskControls
          task={task}
          open={isRestartDialogOpen}
          onClose={() => setIsRestartDialogOpen(false)}
        />
      ) : null}
      <Dialog
        open={shareDialog !== null}
        onClose={() => setShareDialog(null)}
        title="Share"
        maxWidthClassName="max-w-xl"
      >
        {shareDialog ? (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border bg-paper/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">Link</p>
                <button
                  type="button"
                  onClick={() => void handleCopyShareDialogLink(shareDialog.shareUrl)}
                  className="inline-flex items-center justify-center rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Copy
                </button>
              </div>
              <a
                href={shareDialog.shareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block break-all text-sm text-[var(--accent)] underline underline-offset-2"
              >
                {shareDialog.shareUrl}
              </a>
            </div>
            <div className="rounded-2xl border border-border bg-paper/70 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">AI</p>
                <button
                  type="button"
                  onClick={() => void handleCopyShareDialogLink(shareDialog.aiShareUrl)}
                  className="inline-flex items-center justify-center rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-ink transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  Copy
                </button>
              </div>
              <a
                href={shareDialog.aiShareUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-3 block break-all text-sm text-[var(--accent)] underline underline-offset-2"
              >
                {shareDialog.aiShareUrl}
              </a>
            </div>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

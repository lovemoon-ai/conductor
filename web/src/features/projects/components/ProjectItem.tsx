'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Project } from '@/shared/types';
import { useProjectsStore } from '../store';
import { useAgentsStore } from '@/features/agents';
import { useSwipeActions } from '@/shared/hooks/useSwipeActions';
import { formatBindingLabel } from '../utils/format-binding-label';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';

interface ProjectItemProps {
  project: Project;
  isSelected?: boolean;
  onSelect?: (projectId: string) => void;
  dragDisabled?: boolean;
}

const ACTIONS_WIDTH = 72;

const TrashIcon = () => (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const readBindingCandidate = (
  metadata: Record<string, unknown> | null | undefined,
): { daemonHost: string; workspacePath: string } | null => {
  if (!metadata) {
    return null;
  }

  const rawCandidate =
    Object.prototype.hasOwnProperty.call(metadata, 'bindingCandidate')
      ? metadata.bindingCandidate
      : Object.prototype.hasOwnProperty.call(metadata, 'binding_candidate')
        ? metadata.binding_candidate
        : null;
  if (!rawCandidate || typeof rawCandidate !== 'object' || Array.isArray(rawCandidate)) {
    return null;
  }

  const candidate = rawCandidate as Record<string, unknown>;
  const daemonHost =
    typeof candidate.daemonHost === 'string'
      ? candidate.daemonHost.trim()
      : typeof candidate.daemon_host === 'string'
        ? candidate.daemon_host.trim()
        : '';
  const workspacePath =
    typeof candidate.workspacePath === 'string'
      ? candidate.workspacePath.trim()
      : typeof candidate.workspace_path === 'string'
        ? candidate.workspace_path.trim()
        : '';
  if (!daemonHost || !workspacePath) {
    return null;
  }

  return { daemonHost, workspacePath };
};

export function ProjectItem({
  project,
  isSelected = false,
  onSelect,
  dragDisabled = false,
}: ProjectItemProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(project.name);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressStartXRef = useRef(0);
  const longPressStartYRef = useRef(0);
  const longPressFiredRef = useRef(false);
  const renamingRef = useRef(false);
  const skipRenameOnBlurRef = useRef(false);

  const { updateProject, deleteProject } = useProjectsStore();
  const agents = useAgentsStore((state) => state.agents);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();

  const projectRecord = project as Project & Record<string, unknown>;
  const isDefault = Boolean(projectRecord.isDefault);
  const daemonHost = typeof projectRecord.daemonHost === 'string' ? projectRecord.daemonHost : null;
  const workspacePath = typeof projectRecord.workspacePath === 'string' ? projectRecord.workspacePath : null;
  const repoRoot = typeof projectRecord.repoRoot === 'string' ? projectRecord.repoRoot : null;
  const metadata = projectRecord.metadata && typeof projectRecord.metadata === 'object' && !Array.isArray(projectRecord.metadata)
    ? (projectRecord.metadata as Record<string, unknown>)
    : null;
  const isGitProject = Boolean(repoRoot);
  const bindingCandidate = readBindingCandidate(metadata);
  const isBoundProject = Boolean(daemonHost) && !isDefault;
  const isPendingBinding = !isDefault && !daemonHost && Boolean(bindingCandidate);
  const isDaemonOnline = !daemonHost || agents.some((agent) => agent.host === daemonHost);
  const isUnavailable = isBoundProject && !isDaemonOnline;
  const pendingBindingLabel = bindingCandidate
    ? formatBindingLabel(bindingCandidate.daemonHost, bindingCandidate.workspacePath)
    : null;
  const daemonLabel = daemonHost?.trim() || bindingCandidate?.daemonHost || null;
  const daemonTitle = daemonHost?.trim()
    ? formatBindingLabel(daemonHost, workspacePath)
    : pendingBindingLabel;
  const taskStatusCounts = projectRecord.taskStatusCounts as Record<string, number> | undefined;
  const runningCount = taskStatusCounts?.running ?? 0;
  const killedCount = taskStatusCounts?.killed ?? 0;
  const hasMetadataChips = isGitProject || Boolean(daemonLabel) || isUnavailable || isPendingBinding || runningCount > 0 || killedCount > 0;
  const swipe = useSwipeActions({
    maxOffset: isDefault ? 0 : ACTIONS_WIDTH,
  });

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!isEditing) {
      setEditName(project.name);
    }
  }, [isEditing, project.name]);

  useEffect(() => clearLongPress, [clearLongPress]);

  const selectProject = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    if (isEditing) {
      return;
    }
    onSelect?.(project.id);
  };

  const openProjectTasks = () => {
    if (isEditing) {
      return;
    }
    if (isPendingBinding) {
      pushToast({
        title: 'Binding pending',
        description: pendingBindingLabel
          ? `Waiting for daemon confirmation for ${pendingBindingLabel}.`
          : 'Waiting for daemon confirmation before opening tasks.',
        variant: 'warning',
      });
      return;
    }
    if (isUnavailable) {
      pushToast({
        title: 'Daemon offline',
        description: `This project is bound to ${daemonHost}, but the daemon is offline. Reconnect it to open this workspace.`,
        variant: 'warning',
      });
      return;
    }
    router.push(`/app/tasks?projectId=${encodeURIComponent(project.id)}`);
  };

  const handleRename = async () => {
    if (skipRenameOnBlurRef.current) {
      skipRenameOnBlurRef.current = false;
      return;
    }
    if (renamingRef.current) {
      return;
    }
    const nextName = editName.trim();
    if (!nextName) {
      setEditName(project.name);
      setIsEditing(false);
      return;
    }

    renamingRef.current = true;
    if (nextName !== project.name) {
      try {
        await updateProject(project.id, { name: nextName });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to rename project';
        pushToast({
          title: 'Failed to rename project',
          description: message,
          variant: 'error',
        });
        renamingRef.current = false;
        return;
      }
    }
    setIsEditing(false);
    renamingRef.current = false;
    swipe.closeActions();
  };

  const handleCancelRename = () => {
    skipRenameOnBlurRef.current = true;
    setEditName(project.name);
    setIsEditing(false);
    swipe.closeActions();
  };

  const handleTitlePointerDown = useCallback((e: ReactPointerEvent<HTMLHeadingElement>) => {
    if (isDefault || isEditing) {
      return;
    }
    e.stopPropagation();
    clearLongPress();
    longPressStartXRef.current = e.clientX;
    longPressStartYRef.current = e.clientY;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      skipRenameOnBlurRef.current = false;
      setEditName(project.name);
      setIsEditing(true);
      swipe.closeActions();
    }, 500);
  }, [clearLongPress, isDefault, isEditing, project.name, swipe]);

  const handleTitlePointerUp = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const clearLongPressAfterMove = useCallback((clientX: number, clientY: number) => {
    if (!longPressTimerRef.current) {
      return;
    }
    const dx = clientX - longPressStartXRef.current;
    const dy = clientY - longPressStartYRef.current;
    if (dx * dx + dy * dy > 100) {
      clearLongPress();
    }
  }, [clearLongPress]);

  const handleTitlePointerMove = useCallback((e: ReactPointerEvent<HTMLHeadingElement>) => {
    clearLongPressAfterMove(e.clientX, e.clientY);
  }, [clearLongPressAfterMove]);

  const handleCardPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPressAfterMove(e.clientX, e.clientY);
    swipe.onPointerMove(e);
  }, [clearLongPressAfterMove, swipe]);

  const handleCardPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    swipe.onPointerUp(e);
  }, [clearLongPress, swipe]);

  const handleCardPointerCancel = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    clearLongPress();
    swipe.onPointerCancel(e);
  }, [clearLongPress, swipe]);

  const handleDelete = async () => {
    if (isDefault) {
      pushToast({
        title: 'Cannot delete the default project',
        variant: 'warning',
      });
      return;
    }
    const accepted = await confirm({
      title: `Delete project "${project.name}"?`,
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (accepted) {
      try {
        await deleteProject(project.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to delete project';
        pushToast({
          title: 'Failed to delete project',
          description: message,
          variant: 'error',
        });
      }
    }
    swipe.closeActions();
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: project.id,
    disabled: dragDisabled,
  });

  const handleCardPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    swipe.onPointerDown(e);
    // Forward the event to dnd-kit's sortable listener so PointerSensor can start.
    (listeners as Record<string, Function> | undefined)?.onPointerDown?.(e);
  }, [swipe, listeners]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.45 : 1,
    touchAction: dragDisabled ? 'auto' : 'none',
  };

  return (
    <div ref={setNodeRef} style={style}>
      <div className="relative overflow-hidden rounded-2xl">
      {!isDefault && (
        <div className="absolute inset-y-0 right-0 flex z-0" aria-hidden={!swipe.isOpen}>
          <button
            type="button"
            tabIndex={swipe.isOpen ? 0 : -1}
            aria-label="Delete project"
            title="Delete"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void handleDelete();
            }}
            className="w-[72px] h-full flex items-center justify-center border-l border-border bg-[var(--error)]/10 text-[var(--error)] hover:bg-[var(--error)]/20 transition-colors"
          >
            <TrashIcon />
          </button>
        </div>
      )}

      <div
        {...attributes}
        onClick={() => {
          if (swipe.consumeTap()) {
            return;
          }
          selectProject();
        }}
        onDoubleClick={openProjectTasks}
        className={`webapp-card relative z-10 cursor-pointer px-4 pb-4 pt-4 transition-colors hover:border-[var(--accent)] ${
          isSelected ? 'webapp-card-list-pane-active' : 'webapp-card-list-pane-idle'
        } ${isUnavailable || isPendingBinding ? 'opacity-70' : ''}`}
        role="button"
        tabIndex={0}
        aria-pressed={isSelected}
        data-project-id={project.id}
        onPointerDown={handleCardPointerDown}
        onPointerMove={handleCardPointerMove}
        onPointerUp={handleCardPointerUp}
        onPointerCancel={handleCardPointerCancel}
        style={swipe.panelStyle}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            swipe.closeActions();
            return;
          }
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (swipe.isOpen) {
              swipe.closeActions();
              return;
            }
            selectProject();
          }
        }}
      >
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${isDefault ? 'webapp-gradient-bg' : 'bg-accent/10'}`}>
            <svg className={`w-5 h-5 ${isDefault ? 'text-white' : 'text-accent'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              {isEditing ? (
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onBlur={() => void handleRename()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleRename();
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      handleCancelRename();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent px-1 -mx-1 text-base font-medium text-ink outline-none ring-1 ring-[var(--accent)] rounded"
                  autoFocus
                />
              ) : (
                <h3
                  className="truncate font-medium select-none"
                  onPointerDown={handleTitlePointerDown}
                  onPointerUp={handleTitlePointerUp}
                  onPointerMove={handleTitlePointerMove}
                  onPointerCancel={handleTitlePointerUp}
                >
                  {project.name}
                </h3>
              )}
            </div>
            {hasMetadataChips ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted">
                {isGitProject ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--accent)]">
                    git
                  </span>
                ) : null}
                {daemonLabel ? (
                  <span
                    title={daemonTitle ?? daemonLabel}
                    className="flex max-w-[12rem] items-center gap-1 truncate rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted"
                  >
                    {daemonLabel}
                  </span>
                ) : null}
                {isUnavailable ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--warning)]/10 px-1.5 py-0.5 text-xs font-medium text-ink">
                    Daemon offline
                  </span>
                ) : isPendingBinding ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--paper)] px-1.5 py-0.5 text-xs font-medium text-muted">
                    Binding pending
                  </span>
                ) : null}
                {runningCount > 0 ? (
                  <span className="flex items-center gap-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                    {runningCount} running
                  </span>
                ) : null}
                {killedCount > 0 ? (
                  <span className="flex items-center gap-1 rounded bg-[var(--error)]/10 px-1.5 py-0.5 text-xs font-medium text-[var(--error)]">
                    {killedCount} killed
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

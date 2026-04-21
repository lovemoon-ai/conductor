'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTasksStore } from '../store';
import { useProjectsStore } from '@/features/projects';
import { filterTasksByProject } from '../utils/task-filter';
import { TaskItem } from './TaskItem';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';

export type TaskListViewMode = 'list';

const EmptyIcon = () => (
  <svg className="h-16 w-16 text-muted/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
  </svg>
);

export const RefreshIcon = ({ spinning = false }: { spinning?: boolean }) => (
  <svg
    className={`h-4 w-4 ${spinning ? 'animate-spin' : ''}`}
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const TASK_REORDER_ANIMATION_MS = 260;

const prefersReducedMotion = (): boolean => {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
};

interface TaskListProps {
  viewMode: TaskListViewMode;
  activeTaskId?: string | null;
  onOpenTask?: (taskId: string) => void;
  desktopListPaneMode?: boolean;
  projectFilter?: string | null;
  runningOnly?: boolean;
}

export function TaskList({
  activeTaskId = null,
  onOpenTask,
  desktopListPaneMode = false,
  projectFilter,
  runningOnly = false,
}: TaskListProps) {
  const { tasks, isLoading, unreadTaskIds, currentProjectFilter, deleteTask } = useTasksStore();
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
  const itemWrapperRefs = useRef(new Map<string, HTMLDivElement>());
  const previousRectsRef = useRef(new Map<string, DOMRect>());
  const previousOrderRef = useRef<string[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const effectiveProjectFilter = projectFilter !== undefined ? projectFilter : currentProjectFilter;
  const projectVisibleTasks = useMemo(
    () => filterTasksByProject(tasks, effectiveProjectFilter, hiddenProjectIds),
    [tasks, effectiveProjectFilter, hiddenProjectIds],
  );
  const visibleTasks = useMemo(
    () => runningOnly
      ? projectVisibleTasks.filter((task) => task.status === 'running' || task.status === 'killing')
      : projectVisibleTasks,
    [projectVisibleTasks, runningOnly],
  );

  const showProjectInfo = !effectiveProjectFilter;
  const projectMap = useMemo(() => {
    if (!showProjectInfo) return null;
    const map = new Map<string, { name: string; daemonHost: string | null }>();
    for (const project of projects) {
      map.set(project.id, { name: project.name, daemonHost: project.daemonHost ?? null });
    }
    return map;
  }, [projects, showProjectInfo]);
  const currentProjectName = effectiveProjectFilter
    ? projects.find((project) => project.id === effectiveProjectFilter)?.name
    : null;
  const selectedCount = selectedTaskIds.size;
  const selectionMode = selectedCount > 0;
  const hasToolbarContent = selectionMode;
  const allTaskIds = useMemo(() => visibleTasks.map((task) => task.id), [visibleTasks]);
  const allSelected = allTaskIds.length > 0 && selectedCount === allTaskIds.length;

  useEffect(() => (
    () => {
      if (animationFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    }
  ), []);

  useEffect(() => {
    setSelectedTaskIds((prev) => {
      const activeTaskIds = new Set(allTaskIds);
      const filteredTaskIds = [...prev].filter((taskId) => activeTaskIds.has(taskId));
      if (filteredTaskIds.length === prev.size) {
        return prev;
      }
      return new Set(filteredTaskIds);
    });
  }, [allTaskIds]);

  useLayoutEffect(() => {
    const currentRects = new Map<string, DOMRect>();
    allTaskIds.forEach((taskId) => {
      const node = itemWrapperRefs.current.get(taskId);
      if (node) {
        currentRects.set(taskId, node.getBoundingClientRect());
      }
    });

    const previousOrder = previousOrderRef.current;
    const shouldAnimate =
      desktopListPaneMode &&
      previousOrder.length > 0 &&
      previousOrder.join('|') !== allTaskIds.join('|') &&
      !prefersReducedMotion();

    if (shouldAnimate) {
      const animatedNodes: HTMLDivElement[] = [];

      allTaskIds.forEach((taskId) => {
        const node = itemWrapperRefs.current.get(taskId);
        const currentRect = currentRects.get(taskId);
        const previousRect = previousRectsRef.current.get(taskId);
        if (!node || !currentRect || !previousRect) {
          return;
        }

        const deltaX = previousRect.left - currentRect.left;
        const deltaY = previousRect.top - currentRect.top;
        if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
          return;
        }

        node.style.transition = 'none';
        node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
        node.style.willChange = 'transform';
        animatedNodes.push(node);
      });

      if (animatedNodes.length > 0 && typeof window !== 'undefined') {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
        }
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animatedNodes.forEach((node) => {
            node.style.transition = `transform ${TASK_REORDER_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`;
            node.style.transform = '';
          });
          animationFrameRef.current = null;
        });
      }
    }

    previousRectsRef.current = currentRects;
    previousOrderRef.current = [...allTaskIds];
  }, [allTaskIds, desktopListPaneMode]);

  const setItemWrapperRef = (taskId: string) => (node: HTMLDivElement | null) => {
    if (node) {
      itemWrapperRefs.current.set(taskId, node);
      return;
    }
    itemWrapperRefs.current.delete(taskId);
  };

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedTaskIds(new Set());
      return;
    }
    setSelectedTaskIds(new Set(allTaskIds));
  };

  const handleBatchDelete = async () => {
    if (selectedTaskIds.size === 0 || isDeletingSelected) {
      return;
    }
    const accepted = await confirm({
      title: `Delete ${selectedTaskIds.size} selected task(s)?`,
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) {
      return;
    }

    setIsDeletingSelected(true);
    try {
      await Promise.all([...selectedTaskIds].map((taskId) => deleteTask(taskId)));
      setSelectedTaskIds(new Set());
    } catch {
      pushToast({
        title: 'Failed to delete selected tasks',
        variant: 'error',
      });
    } finally {
      setIsDeletingSelected(false);
    }
  };

  if (isLoading && visibleTasks.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (visibleTasks.length === 0) {
    return (
      <EmptyState
        className="h-72"
        icon={<EmptyIcon />}
        title={runningOnly ? 'No running tasks' : 'No tasks yet'}
        description={
          runningOnly
            ? currentProjectName
              ? `No running tasks found in ${currentProjectName}.`
              : 'No running tasks right now.'
            : currentProjectName
            ? `No tasks found in ${currentProjectName}. Switch projects or create a new task to start work here.`
            : 'Create your first task to start building with Conductor.'
        }
      />
    );
  }

  return (
    <div className={hasToolbarContent ? 'space-y-4' : ''}>
      {hasToolbarContent ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-panel/80 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {selectionMode ? (
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                {selectedCount} selected
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectionMode ? (
              <>
                <button
                  onClick={toggleSelectAll}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-[var(--paper)] hover:text-ink"
                >
                  {allSelected ? 'Clear All' : 'Select All'}
                </button>
                <button
                  onClick={handleBatchDelete}
                  disabled={isDeletingSelected}
                  className="rounded-lg border border-[var(--error)]/30 px-2.5 py-1.5 text-xs font-medium text-[var(--error)] transition-colors hover:bg-[var(--error)]/10 disabled:opacity-50"
                >
                  {isDeletingSelected ? 'Deleting...' : `Delete (${selectedCount})`}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {visibleTasks.map((task) => (
          <div
            key={task.id}
            ref={setItemWrapperRef(task.id)}
            data-task-item-wrapper={task.id}
          >
            <TaskItem
              task={task}
              isUnread={unreadTaskIds.has(task.id)}
              isSelected={selectedTaskIds.has(task.id)}
              isActive={activeTaskId === task.id}
              selectionMode={selectionMode}
              onToggleSelect={toggleTaskSelection}
              onOpenTask={onOpenTask}
              desktopListPaneMode={desktopListPaneMode}
              showProjectInfo={showProjectInfo}
              projectName={projectMap?.get(task.projectId ?? '')?.name ?? null}
              projectDaemonHost={projectMap?.get(task.projectId ?? '')?.daemonHost ?? null}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

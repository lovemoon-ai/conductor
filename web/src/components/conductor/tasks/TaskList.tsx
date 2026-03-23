'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { useProjectsStore } from '@/lib/conductor/stores/projects';
import { TaskItem } from './TaskItem';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { EmptyState } from '../common/EmptyState';
import { useConfirm, useToast } from '../common/FeedbackProvider';

export type TaskListViewMode = 'list' | 'grid';

export const TASK_LIST_VIEW_STORAGE_KEY = 'conductor-task-list-view';

const EmptyIcon = () => (
  <svg className="h-16 w-16 text-muted/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
  </svg>
);

export const ListIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);

export const GridIcon = () => (
  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h6v6H4V4zm0 10h6v6H4v-6zm10-10h6v6h-6V4zm0 10h6v6h-6v-6z" />
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

export function readStoredTaskListViewMode(): TaskListViewMode {
  if (typeof window === 'undefined') {
    return 'list';
  }

  const storedValue = window.localStorage.getItem(TASK_LIST_VIEW_STORAGE_KEY);
  return storedValue === 'grid' ? 'grid' : 'list';
}

interface TaskListProps {
  viewMode: TaskListViewMode;
  activeTaskId?: string | null;
  onOpenTask?: (taskId: string) => void;
  desktopListPaneMode?: boolean;
}

export function TaskList({
  viewMode,
  activeTaskId = null,
  onOpenTask,
  desktopListPaneMode = false,
}: TaskListProps) {
  const { tasks, isLoading, unreadTaskIds, currentProjectFilter, deleteTask } = useTasksStore();
  const projects = useProjectsStore((state) => state.projects);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);

  const currentProjectName = currentProjectFilter
    ? projects.find((project) => project.id === currentProjectFilter)?.name
    : null;
  const selectedCount = selectedTaskIds.size;
  const selectionMode = selectedCount > 0;
  const hasToolbarContent = selectionMode || Boolean(currentProjectName);
  const allTaskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const allSelected = allTaskIds.length > 0 && selectedCount === allTaskIds.length;

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

  if (isLoading && tasks.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (tasks.length === 0) {
    return (
      <EmptyState
        className="h-72"
        icon={<EmptyIcon />}
        title="No tasks yet"
        description={
          currentProjectName
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
            {currentProjectName ? (
              <span className="rounded-full bg-border/60 px-2 py-0.5 text-xs font-medium text-muted">
                {currentProjectName}
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

      <div
        className={viewMode === 'grid'
          ? 'grid gap-4 sm:grid-cols-2 xl:grid-cols-3'
          : 'space-y-3'}
      >
        {tasks.map((task) => (
          <TaskItem
            key={task.id}
            task={task}
            isUnread={unreadTaskIds.has(task.id)}
            isSelected={selectedTaskIds.has(task.id)}
            isActive={activeTaskId === task.id}
            selectionMode={selectionMode}
            onToggleSelect={toggleTaskSelection}
            onOpenTask={onOpenTask}
            desktopListPaneMode={desktopListPaneMode}
            viewMode={viewMode}
          />
        ))}
      </div>
    </div>
  );
}

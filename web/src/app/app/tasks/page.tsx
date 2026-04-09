'use client';

import { Suspense, useState, useEffect, useMemo, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import {
  GridIcon,
  ListIcon,
  RefreshIcon,
  readStoredTaskListViewMode,
  TaskList,
  TASK_LIST_VIEW_STORAGE_KEY,
  type TaskListViewMode,
} from '@/features/tasks';
import { CreateTaskDialog } from '@/features/tasks';
import { TaskDetailPane } from '@/features/tasks';
import { useTasksStore } from '@/features/tasks';
import { useProjectsStore } from '@/features/projects';
import { filterTasksByProject } from '@/features/tasks';

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

function TasksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [viewMode, setViewMode] = useState<TaskListViewMode>(() => readStoredTaskListViewMode());
  const [isDesktop, setIsDesktop] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const previousRequestedTaskIdRef = useRef<string | null>(null);
  const shouldHonorIncomingTaskIdRef = useRef(false);
  const setProjectFilter = useTasksStore((state) => state.setProjectFilter);
  const fetchTasks = useTasksStore((state) => state.fetchTasks);
  const isLoading = useTasksStore((state) => state.isLoading);
  const tasks = useTasksStore((state) => state.tasks);
  const projects = useProjectsStore((state) => state.projects);
  const projectId = searchParams.get('projectId');
  const requestedTaskId = searchParams.get('taskId');
  const visibleTasks = useMemo(() => filterTasksByProject(tasks, projectId), [tasks, projectId]);
  const taskCount = visibleTasks.length;
  const currentProjectName = projectId
    ? projects.find((project) => project.id === projectId)?.name
    : null;
  const desktopListMode = isDesktop && viewMode === 'list';
  const inlineDetailEnabled = desktopListMode && taskCount > 0;
  const visibleTaskIds = useMemo(() => new Set(visibleTasks.map((task) => task.id)), [visibleTasks]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
    const updateViewport = () => {
      setIsDesktop(mediaQuery.matches);
    };

    updateViewport();

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', updateViewport);
      return () => mediaQuery.removeEventListener('change', updateViewport);
    }

    mediaQuery.addListener(updateViewport);
    return () => mediaQuery.removeListener(updateViewport);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(TASK_LIST_VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    setProjectFilter(projectId || null);
  }, [projectId, setProjectFilter]);

  useEffect(() => {
    if (!inlineDetailEnabled) {
      previousRequestedTaskIdRef.current = requestedTaskId;
      shouldHonorIncomingTaskIdRef.current = false;
      return;
    }

    const previousRequestedTaskId = previousRequestedTaskIdRef.current;
    previousRequestedTaskIdRef.current = requestedTaskId;
    const requestedTaskChanged = previousRequestedTaskId !== requestedTaskId;
    shouldHonorIncomingTaskIdRef.current = requestedTaskChanged;

    if (requestedTaskChanged && requestedTaskId && visibleTaskIds.has(requestedTaskId)) {
      setSelectedTaskId((prev) => (prev === requestedTaskId ? prev : requestedTaskId));
      return;
    }

    const nextTaskId = selectedTaskId && visibleTaskIds.has(selectedTaskId)
      ? selectedTaskId
      : requestedTaskId && visibleTaskIds.has(requestedTaskId)
        ? requestedTaskId
        : visibleTasks[0]?.id ?? null;

    setSelectedTaskId((prev) => (prev === nextTaskId ? prev : nextTaskId));
  }, [inlineDetailEnabled, requestedTaskId, selectedTaskId, visibleTaskIds, visibleTasks]);

  useEffect(() => {
    if (!inlineDetailEnabled) {
      return;
    }

    const currentTaskId = searchParams.get('taskId');
    if (
      shouldHonorIncomingTaskIdRef.current
      && currentTaskId
      && currentTaskId !== selectedTaskId
      && visibleTaskIds.has(currentTaskId)
    ) {
      shouldHonorIncomingTaskIdRef.current = false;
      return;
    }
    shouldHonorIncomingTaskIdRef.current = false;

    if ((currentTaskId ?? null) === selectedTaskId) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    if (selectedTaskId) {
      nextSearchParams.set('taskId', selectedTaskId);
    } else {
      nextSearchParams.delete('taskId');
    }

    const nextQuery = nextSearchParams.toString();
    router.replace(nextQuery ? `/app/tasks?${nextQuery}` : '/app/tasks', { scroll: false });
  }, [inlineDetailEnabled, router, searchParams, selectedTaskId, visibleTaskIds]);

  const handleRefresh = () => {
    fetchTasks(projectId ?? undefined, { recoverStale: true });
  };

  const handleSelectTask = (taskId: string) => {
    if (!inlineDetailEnabled) {
      return;
    }
    setSelectedTaskId(taskId);
  };

  const handleTaskCreated = (taskId: string) => {
    setSelectedTaskId(taskId);
  };

  return (
    <>
      <Header
        title={currentProjectName ? `Task ${taskCount} · ${currentProjectName}` : `Task ${taskCount}`}
        compact
        showConnectionStatus={inlineDetailEnabled && Boolean(selectedTaskId)}
        connectionTaskId={inlineDetailEnabled ? selectedTaskId : null}
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl bg-paper/80 p-1">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                aria-label="List view"
                title="List view"
                aria-pressed={viewMode === 'list'}
                className={`inline-flex items-center rounded-lg p-2 text-xs font-medium transition-colors ${
                  viewMode === 'list'
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <ListIcon />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                title="Grid view"
                aria-pressed={viewMode === 'grid'}
                className={`inline-flex items-center rounded-lg p-2 text-xs font-medium transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <GridIcon />
              </button>
            </div>

            <button
              onClick={handleRefresh}
              disabled={isLoading}
              aria-label={isLoading ? 'Refreshing tasks' : 'Refresh tasks'}
              title={isLoading ? 'Refreshing tasks' : 'Refresh tasks'}
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshIcon spinning={isLoading} />
            </button>

            <button
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create task"
              title="Create task"
              className="webapp-btn-primary flex items-center justify-center p-2 text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-hidden px-4 pb-4 pt-4">
        {inlineDetailEnabled ? (
          <div className="flex h-full gap-4">
            <div className="min-h-0 min-w-0 shrink-0 overflow-y-auto pr-1 webapp-scrollbar md:w-[19.2rem] lg:w-[20.8rem] xl:w-[24rem]">
              <TaskList
                viewMode={viewMode}
                activeTaskId={selectedTaskId}
                onOpenTask={handleSelectTask}
                desktopListPaneMode
                projectFilter={projectId}
              />
            </div>
            <div className="hidden min-h-0 min-w-0 flex-1 overflow-hidden rounded-[24px] border border-border bg-paper shadow-sm md:flex md:flex-col">
              {selectedTaskId ? (
                <TaskDetailPane
                  taskId={selectedTaskId}
                  compactHeader
                  showConnectionStatus
                  hideHeader
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="h-full overflow-y-auto webapp-scrollbar">
            <TaskList viewMode={viewMode} projectFilter={projectId} />
          </div>
        )}
      </div>

      <CreateTaskDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        onCreatedTask={desktopListMode ? handleTaskCreated : undefined}
        defaultProjectId={projectId}
      />
    </>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksPageContent />
    </Suspense>
  );
}

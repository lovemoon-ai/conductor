'use client';

import { Suspense, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useToast } from '@/components/common/FeedbackProvider';
import { Header } from '@/components/layout/Header';
import {
  RefreshIcon,
  TaskList,
} from '@/features/tasks';
import { CreateTaskDialog } from '@/features/tasks';
import { TaskDetailPane } from '@/features/tasks';
import { useTasksStore } from '@/features/tasks';
import { useProjectsStore } from '@/features/projects';
import { filterTasksByProject } from '@/features/tasks';
import { useUserPreferencesStore } from '@/features/user-preferences/store';
import { parseTaskType, type TaskType } from '@/lib/tasks/task-config';

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

function TasksPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { pushToast } = useToast();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const viewMode = 'list' as const;
  const [isDesktop, setIsDesktop] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const previousRequestedTaskIdRef = useRef<string | null>(null);
  const shouldHonorIncomingTaskIdRef = useRef(false);
  const showRunningOnly = useUserPreferencesStore((state) => state.taskListRunningOnly);
  const taskListPreferencesError = useUserPreferencesStore((state) => state.taskListPreferencesError);
  const hydrateTaskListPreferences = useUserPreferencesStore((state) => state.hydrateTaskListPreferences);
  const setTaskListRunningOnly = useUserPreferencesStore((state) => state.setTaskListRunningOnly);
  const setProjectFilter = useTasksStore((state) => state.setProjectFilter);
  const fetchTasks = useTasksStore((state) => state.fetchTasks);
  const isLoading = useTasksStore((state) => state.isLoading);
  const tasks = useTasksStore((state) => state.tasks);
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const setSelectedProjectId = useProjectsStore((state) => state.setSelectedProjectId);
  const projectIdFromUrl = searchParams.get('projectId');
  const hiddenProjectIdSet = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds]);
  const projectId = projectIdFromUrl && !hiddenProjectIdSet.has(projectIdFromUrl) ? projectIdFromUrl : null;
  const requestedTaskId = searchParams.get('taskId');
  const taskTypeFilterParam = searchParams.get('taskType');
  const taskTypeFilter: TaskType | null = parseTaskType(taskTypeFilterParam);
  const daemonHostFilterParam = searchParams.get('daemonHost');
  const daemonHostFilter = daemonHostFilterParam && daemonHostFilterParam.trim() ? daemonHostFilterParam : null;
  const projectDaemonHostMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const project of projects) {
      map.set(project.id, project.daemonHost ?? null);
    }
    return map;
  }, [projects]);
  const projectVisibleTasks = useMemo(() => filterTasksByProject(tasks, projectId, hiddenProjectIds), [tasks, projectId, hiddenProjectIds]);
  const runningFilteredTasks = useMemo(
    () => showRunningOnly
      ? projectVisibleTasks.filter((task) => task.status === 'running' || task.status === 'killing')
      : projectVisibleTasks,
    [projectVisibleTasks, showRunningOnly],
  );
  const typeFilteredTasks = useMemo(
    () => taskTypeFilter
      ? runningFilteredTasks.filter((task) => (task.taskType ?? 'ai_task') === taskTypeFilter)
      : runningFilteredTasks,
    [runningFilteredTasks, taskTypeFilter],
  );
  const visibleTasks = useMemo(
    () => daemonHostFilter
      ? typeFilteredTasks.filter((task) => {
          const host = task.projectId ? projectDaemonHostMap.get(task.projectId) ?? null : null;
          return host === daemonHostFilter;
        })
      : typeFilteredTasks,
    [typeFilteredTasks, daemonHostFilter, projectDaemonHostMap],
  );
  const taskCount = visibleTasks.length;
  const currentProjectName = projectId
    ? projects.find((project) => project.id === projectId)?.name
    : null;
  const projectTaskCountLabel = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
  const desktopListMode = isDesktop;
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
    void hydrateTaskListPreferences();
  }, [hydrateTaskListPreferences]);

  useEffect(() => {
    if (!taskListPreferencesError) {
      return;
    }
    pushToast({
      title: 'Task view preference not saved',
      description: taskListPreferencesError,
      variant: 'error',
    });
  }, [pushToast, taskListPreferencesError]);

  useEffect(() => {
    if (!projectIdFromUrl || !hiddenProjectIdSet.has(projectIdFromUrl)) {
      return;
    }

    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.delete('projectId');
    const nextQuery = nextSearchParams.toString();
    router.replace(nextQuery ? `/app/tasks?${nextQuery}` : '/app/tasks', { scroll: false });
  }, [hiddenProjectIdSet, projectIdFromUrl, router, searchParams]);

  useEffect(() => {
    setProjectFilter(projectId || null);
    setSelectedProjectId(projectId || null);
  }, [projectId, setProjectFilter, setSelectedProjectId]);

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

  const replaceTaskRoute = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const nextSearchParams = new URLSearchParams(searchParams.toString());
      mutate(nextSearchParams);
      const nextQuery = nextSearchParams.toString();
      router.replace(nextQuery ? `/app/tasks?${nextQuery}` : '/app/tasks', { scroll: false });
    },
    [router, searchParams],
  );

  const handleFilterByTaskType = useCallback(
    (nextType: TaskType) => {
      replaceTaskRoute((params) => {
        if (taskTypeFilter === nextType) {
          params.delete('taskType');
        } else {
          params.set('taskType', nextType);
        }
      });
    },
    [replaceTaskRoute, taskTypeFilter],
  );

  const handleFilterByProject = useCallback(
    (nextProjectId: string) => {
      replaceTaskRoute((params) => {
        if (projectId === nextProjectId) {
          params.delete('projectId');
        } else {
          params.set('projectId', nextProjectId);
        }
        params.delete('taskId');
      });
    },
    [projectId, replaceTaskRoute],
  );

  const handleFilterByDaemonHost = useCallback(
    (nextDaemonHost: string) => {
      replaceTaskRoute((params) => {
        if (daemonHostFilter === nextDaemonHost) {
          params.delete('daemonHost');
        } else {
          params.set('daemonHost', nextDaemonHost);
        }
      });
    },
    [daemonHostFilter, replaceTaskRoute],
  );

  const handleTitleDoubleClick = () => {
    void setTaskListRunningOnly(!showRunningOnly);
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
        title={currentProjectName ? `${currentProjectName} (${projectTaskCountLabel})` : `Tasks(${taskCount})`}
        compact
        onTitleDoubleClick={handleTitleDoubleClick}
        titleDoubleClickHint={showRunningOnly
          ? 'Double-click to show all tasks.'
          : 'Double-click to show running tasks only.'}
        showConnectionStatus={inlineDetailEnabled && Boolean(selectedTaskId)}
        connectionTaskId={inlineDetailEnabled ? selectedTaskId : null}
        actions={
          <div className="flex items-center gap-2">
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
                runningOnly={showRunningOnly}
                taskTypeFilter={taskTypeFilter}
                daemonHostFilter={daemonHostFilter}
                onFilterByTaskType={handleFilterByTaskType}
                onFilterByProject={handleFilterByProject}
                onFilterByDaemonHost={handleFilterByDaemonHost}
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
            <TaskList
              viewMode={viewMode}
              projectFilter={projectId}
              runningOnly={showRunningOnly}
              taskTypeFilter={taskTypeFilter}
              daemonHostFilter={daemonHostFilter}
              onFilterByTaskType={handleFilterByTaskType}
              onFilterByProject={handleFilterByProject}
              onFilterByDaemonHost={handleFilterByDaemonHost}
            />
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

'use client';

import { Suspense, useState, useEffect, useMemo, useRef, useCallback, useSyncExternalStore } from 'react';
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
import { useAgentsStore } from '@/features/agents';
import { computeProjectGroups } from '@/features/projects/utils/project-groups';
import { getVisibleProjectGroupsForProjectList } from '@/features/projects/utils/project-list-order';
import { isProjectTaskGraphEnabled } from '@/features/projects/utils/task-graph-settings';
import { filterTasksByProject, getStableTaskBackend, resolveTaskDaemonHost } from '@/features/tasks';
import { buildTaskDetailHref } from '@/features/tasks/utils/task-navigation';
import { useUserPreferencesStore } from '@/features/user-preferences/store';
import { parseTaskType, type TaskType } from '@/lib/tasks/task-config';

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

const subscribeToDesktopViewport = (onStoreChange: () => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }

  const mediaQuery = window.matchMedia(DESKTOP_MEDIA_QUERY);
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', onStoreChange);
    return () => mediaQuery.removeEventListener('change', onStoreChange);
  }

  mediaQuery.addListener(onStoreChange);
  return () => mediaQuery.removeListener(onStoreChange);
};

const getDesktopViewportSnapshot = () =>
  typeof window !== 'undefined' && window.matchMedia(DESKTOP_MEDIA_QUERY).matches;

function TasksPageContent() {
  const { push, replace } = useRouter();
  const searchParams = useSearchParams();
  const { pushToast } = useToast();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const isDesktop = useSyncExternalStore(subscribeToDesktopViewport, getDesktopViewportSnapshot, () => false);
  const previousRequestedTaskIdRef = useRef<string | null>(null);
  const shouldHonorIncomingTaskIdRef = useRef(false);
  const showRunningOnly = useUserPreferencesStore((state) => state.taskListRunningOnly);
  const taskListPreferencesError = useUserPreferencesStore((state) => state.taskListPreferencesError);
  const hydrateTaskListPreferences = useUserPreferencesStore((state) => state.hydrateTaskListPreferences);
  const setTaskListRunningOnly = useUserPreferencesStore((state) => state.setTaskListRunningOnly);
  const setProjectFilter = useTasksStore((state) => state.setProjectFilter);
  const setProjectGroupFilter = useTasksStore((state) => state.setProjectGroupFilter);
  const fetchTasks = useTasksStore((state) => state.fetchTasks);
  const fetchTasksForProjects = useTasksStore((state) => state.fetchTasksForProjects);
  const isLoading = useTasksStore((state) => state.isLoading);
  const tasks = useTasksStore((state) => state.tasks);
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const setSelectedProjectId = useProjectsStore((state) => state.setSelectedProjectId);
  const agents = useAgentsStore((state) => state.agents);
  const projectIdFromUrl = searchParams.get('projectId');
  const hiddenProjectIdSet = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds]);
  const projectId = projectIdFromUrl && !hiddenProjectIdSet.has(projectIdFromUrl) ? projectIdFromUrl : null;
  const requestedTaskId = searchParams.get('taskId');
  const taskTypeFilterParam = searchParams.get('taskType');
  const taskTypeFilter: TaskType | null = parseTaskType(taskTypeFilterParam);
  const daemonHostFilterParam = searchParams.get('daemonHost');
  const daemonHostFilter = daemonHostFilterParam && daemonHostFilterParam.trim() ? daemonHostFilterParam : null;
  const backendFilterParam = searchParams.get('backend');
  const backendFilter = backendFilterParam && backendFilterParam.trim() ? backendFilterParam : null;
  const requestedViewMode = searchParams.get('view') === 'graph' ? 'graph' : 'list';
  const projectDaemonHostMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const project of projects) {
      map.set(project.id, project.daemonHost ?? null);
    }
    return map;
  }, [projects]);
  const onlineDaemonHosts = useMemo(
    () => new Set(agents.flatMap((agent) => {
      const host = agent.host.trim();
      return host ? [host] : [];
    })),
    [agents],
  );
  const switchableProjectGroups = useMemo(
    () => getVisibleProjectGroupsForProjectList(projects, {
      hiddenProjectIds,
      onlineDaemonHosts,
    }),
    [hiddenProjectIds, onlineDaemonHosts, projects],
  );
  // When the URL-selected project belongs to a cross-daemon merged group,
  // expand it to every member so the task list pulls tasks from each
  // daemon's same-named project. Single-member groups behave exactly as
  // before (a single projectId in / out).
  const projectGroups = useMemo(() => computeProjectGroups(projects), [projects]);
  const currentGroup = useMemo(() => {
    if (!projectId) return null;
    return projectGroups.find((group) =>
      group.members.some((member) => member.id === projectId),
    ) ?? null;
  }, [projectGroups, projectId]);
  const currentGroupMemberIds = useMemo(
    () => (currentGroup ? currentGroup.members.map((member) => member.id) : []),
    [currentGroup],
  );
  const isMergedGroup = currentGroup ? currentGroup.isMerged : false;
  // The "scope" we feed both the task fetch and the in-memory filter:
  //  - merged group view → all member ids
  //  - single project view → [projectId]
  //  - no project selected → []
  const projectScope = useMemo(() => {
    if (isMergedGroup && currentGroupMemberIds.length > 1) {
      return currentGroupMemberIds;
    }
    return projectId ? [projectId] : [];
  }, [isMergedGroup, currentGroupMemberIds, projectId]);
  const projectScopeKey = useMemo(() => projectScope.slice().sort().join(','), [projectScope]);
  const taskGraphEnabled = useMemo(() => {
    if (projectScope.length === 0) return false;
    const scopedProjectIds = new Set(projectScope);
    return projects.some((project) =>
      scopedProjectIds.has(project.id) && isProjectTaskGraphEnabled(project),
    );
  }, [projectScope, projects]);
  const viewMode = taskGraphEnabled && requestedViewMode === 'graph' ? 'graph' : 'list';
  const currentProjectSwitchIndex = useMemo(() => {
    if (!projectId) {
      return -1;
    }
    return switchableProjectGroups.findIndex((group) =>
      group.members.some((member) => member.id === projectId),
    );
  }, [projectId, switchableProjectGroups]);
  // Defense-in-depth: even though the server-side list endpoint already
  // hides PTY tasks that are bound to an AI task via AttachedTerminal, any
  // single-task fetch path (e.g. deep-linking to a PTY id, or a stale WS
  // payload) could re-introduce the row to the client store. Compute the set
  // of "claimed" PTY task ids from the AI tasks that own them and filter
  // those out before any downstream count/filter sees them.
  const attachedPtyTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of tasks) {
      const claimed = t.attachedTerminal?.ptyTaskId;
      if (claimed) ids.add(claimed);
    }
    return ids;
  }, [tasks]);
  const tasksWithoutAttachedPty = useMemo(
    () =>
      attachedPtyTaskIds.size === 0
        ? tasks
        : tasks.filter((t) => !attachedPtyTaskIds.has(t.id)),
    [tasks, attachedPtyTaskIds],
  );
  const projectVisibleTasks = useMemo(
    () => filterTasksByProject(tasksWithoutAttachedPty, projectScope.length > 0 ? projectScope : null, hiddenProjectIds),
    [tasksWithoutAttachedPty, projectScope, hiddenProjectIds],
  );
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
  const daemonFilteredTasks = useMemo(
    () => daemonHostFilter
      ? typeFilteredTasks.filter((task) => resolveTaskDaemonHost(task, projectDaemonHostMap) === daemonHostFilter)
      : typeFilteredTasks,
    [typeFilteredTasks, daemonHostFilter, projectDaemonHostMap],
  );
  const visibleTasks = useMemo(
    () => backendFilter
      ? daemonFilteredTasks.filter((task) => getStableTaskBackend(task) === backendFilter)
      : daemonFilteredTasks,
    [daemonFilteredTasks, backendFilter],
  );
  const taskCount = visibleTasks.length;
  const currentProjectName = projectId
    ? projects.find((project) => project.id === projectId)?.name
    : null;
  const projectTaskCountLabel = `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
  const desktopListMode = isDesktop && viewMode === 'list';
  const inlineDetailEnabled = desktopListMode && taskCount > 0;
  const visibleTaskIds = useMemo(() => new Set(visibleTasks.map((task) => task.id)), [visibleTasks]);

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
    replace(nextQuery ? `/app/tasks?${nextQuery}` : '/app/tasks', { scroll: false });
  }, [hiddenProjectIdSet, projectIdFromUrl, replace, searchParams]);

  useEffect(() => {
    if (isMergedGroup && currentGroupMemberIds.length > 1) {
      setProjectGroupFilter(currentGroupMemberIds);
    } else {
      setProjectFilter(projectId || null);
    }
    setSelectedProjectId(projectId || null);
    // `projectScopeKey` collapses the array dependency to a stable string so
    // the effect only re-runs when the actual member set changes.
  }, [
    projectId,
    isMergedGroup,
    projectScopeKey,
    currentGroupMemberIds,
    setProjectFilter,
    setProjectGroupFilter,
    setSelectedProjectId,
  ]);

  const handleRefresh = () => {
    if (isMergedGroup && currentGroupMemberIds.length > 1) {
      void fetchTasksForProjects(currentGroupMemberIds, { recoverStale: true });
    } else {
      void fetchTasks(projectId ?? undefined, { recoverStale: true });
    }
  };

  const replaceTaskRoute = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const nextSearchParams = new URLSearchParams(searchParams.toString());
      mutate(nextSearchParams);
      const nextQuery = nextSearchParams.toString();
      replace(nextQuery ? `/app/tasks?${nextQuery}` : '/app/tasks', { scroll: false });
    },
    [replace, searchParams],
  );

  const handleProjectTitleSwipe = useCallback((offset: -1 | 1) => {
    if (currentProjectSwitchIndex === -1) {
      return;
    }
    const targetGroup = switchableProjectGroups[currentProjectSwitchIndex + offset];
    const targetProjectId = targetGroup?.members[0]?.id;
    if (!targetProjectId) {
      return;
    }

    setSelectedProjectId(targetProjectId);
    replaceTaskRoute((params) => {
      params.set('projectId', targetProjectId);
      params.delete('taskId');
      params.delete('view');
    });
  }, [currentProjectSwitchIndex, replaceTaskRoute, setSelectedProjectId, switchableProjectGroups]);

  const canSwipeProjectTitle =
    !isDesktop
    && viewMode === 'list'
    && currentProjectSwitchIndex >= 0
    && switchableProjectGroups.length > 1;

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const effectiveSelectedTaskId = useMemo(() => {
    if (!inlineDetailEnabled) {
      return null;
    }
    if (selectedTaskId && visibleTaskIds.has(selectedTaskId)) {
      return selectedTaskId;
    }
    if (requestedTaskId && visibleTaskIds.has(requestedTaskId)) {
      return requestedTaskId;
    }
    return visibleTasks[0]?.id ?? null;
  }, [inlineDetailEnabled, requestedTaskId, selectedTaskId, visibleTaskIds, visibleTasks]);

  useEffect(() => {
    if (!inlineDetailEnabled || requestedTaskId === effectiveSelectedTaskId) {
      return;
    }
    replaceTaskRoute((params) => {
      if (effectiveSelectedTaskId) {
        params.set('taskId', effectiveSelectedTaskId);
      } else {
        params.delete('taskId');
      }
    });
  }, [inlineDetailEnabled, replaceTaskRoute, requestedTaskId, effectiveSelectedTaskId]);

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

  const handleFilterByBackend = useCallback(
    (nextBackend: string) => {
      replaceTaskRoute((params) => {
        if (backendFilter === nextBackend) {
          params.delete('backend');
        } else {
          params.set('backend', nextBackend);
        }
      });
    },
    [backendFilter, replaceTaskRoute],
  );

  const handleTitleDoubleClick = () => {
    void setTaskListRunningOnly(!showRunningOnly);
  };

  const handleSelectTask = useCallback((taskId: string) => {
    if (!inlineDetailEnabled) {
      return;
    }
    setSelectedTaskId(taskId);
    replaceTaskRoute((params) => {
      params.set('taskId', taskId);
    });
  }, [inlineDetailEnabled, replaceTaskRoute]);

  const buildCurrentTaskListHref = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('taskId');
    if (viewMode === 'graph') {
      params.set('view', 'graph');
    }
    const query = params.toString();
    return query ? `/app/tasks?${query}` : '/app/tasks';
  }, [searchParams, viewMode]);

  const handleOpenTaskPage = useCallback((taskId: string) => {
    push(buildTaskDetailHref(taskId, buildCurrentTaskListHref()));
  }, [buildCurrentTaskListHref, push]);

  const handleTaskCreated = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    replaceTaskRoute((params) => {
      params.set('taskId', taskId);
    });
  }, [replaceTaskRoute]);

  return (
    <>
      <Header
        title={currentProjectName ? `${currentProjectName} (${projectTaskCountLabel})` : `Tasks(${taskCount})`}
        compact
        onTitleDoubleClick={handleTitleDoubleClick}
        onTitleSwipeLeft={canSwipeProjectTitle ? () => handleProjectTitleSwipe(1) : undefined}
        onTitleSwipeRight={canSwipeProjectTitle ? () => handleProjectTitleSwipe(-1) : undefined}
        titleDoubleClickHint={showRunningOnly
          ? 'Double-click to show all tasks.'
          : 'Double-click to show running tasks only.'}
        showConnectionStatus={inlineDetailEnabled && Boolean(effectiveSelectedTaskId)}
        connectionTaskId={inlineDetailEnabled ? effectiveSelectedTaskId : null}
        actions={
          <div className="flex items-center gap-2">
            <button type="button"
              onClick={handleRefresh}
              disabled={isLoading}
              aria-label={isLoading ? 'Refreshing tasks' : 'Refresh tasks'}
              title={isLoading ? 'Refreshing tasks' : 'Refresh tasks'}
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshIcon spinning={isLoading} />
            </button>

            <button type="button"
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create task"
              title="Create task"
              className="webapp-btn-primary flex items-center justify-center p-2 text-sm"
            >
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        }
      />

      <div className={viewMode === 'graph' ? 'flex-1 overflow-hidden' : 'flex-1 overflow-hidden px-4 pb-4 pt-4'}>
        {inlineDetailEnabled ? (
          <div className="flex h-full gap-4">
            <div className="min-h-0 min-w-0 shrink-0 overflow-y-auto pr-1 webapp-scrollbar md:w-[19.2rem] lg:w-[20.8rem] xl:w-[24rem]">
              <TaskList
                viewMode={viewMode}
                activeTaskId={effectiveSelectedTaskId}
                onOpenTask={handleSelectTask}
                desktopListPaneMode
                projectFilter={projectScope.length > 0 ? projectScope : null}
                runningOnly={showRunningOnly}
                taskTypeFilter={taskTypeFilter}
                daemonHostFilter={daemonHostFilter}
                backendFilter={backendFilter}
                onFilterByTaskType={handleFilterByTaskType}
                onFilterByProject={handleFilterByProject}
                onFilterByDaemonHost={handleFilterByDaemonHost}
                onFilterByBackend={handleFilterByBackend}
              />
            </div>
            <div className="hidden min-h-0 min-w-0 flex-1 overflow-hidden rounded-[24px] border border-border bg-paper shadow-sm md:flex md:flex-col">
              {effectiveSelectedTaskId ? (
                <TaskDetailPane
                  taskId={effectiveSelectedTaskId}
                  compactHeader
                  showConnectionStatus
                  hideHeader
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className={viewMode === 'graph' ? 'h-full' : 'h-full overflow-y-auto webapp-scrollbar'}>
            <TaskList
              viewMode={viewMode}
              // Must mirror the inline (desktop) branch's expanded scope —
              // passing the raw single `projectId` here makes the merged-
              // project view appear empty whenever the URL's projectId
              // happens to be a different daemon than the one carrying the
              // tasks. The page-level `taskCount` (computed from
              // `projectScope`) was correct but TaskList was silently
              // filtering to one member only, causing "title says N tasks
              // but the list is empty" in the single-pane / mobile view.
              projectFilter={projectScope.length > 0 ? projectScope : null}
              runningOnly={showRunningOnly}
              taskTypeFilter={taskTypeFilter}
              daemonHostFilter={daemonHostFilter}
              backendFilter={backendFilter}
              onFilterByTaskType={handleFilterByTaskType}
              onFilterByProject={handleFilterByProject}
              onFilterByDaemonHost={handleFilterByDaemonHost}
              onFilterByBackend={handleFilterByBackend}
              onOpenTask={viewMode === 'graph' ? handleOpenTaskPage : undefined}
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

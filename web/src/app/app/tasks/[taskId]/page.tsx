'use client';

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { TitleSwipeProgress } from '@/components/layout/Header';
import { TaskDetailPane } from '@/features/tasks';
import { useTasksStore } from '@/features/tasks/store';
import { useProjectsStore } from '@/features/projects';
import { useAuthStore } from '@/features/auth/store';
import { useUserPreferencesStore } from '@/features/user-preferences/store';
import { computeProjectGroups } from '@/features/projects/utils/project-groups';
import { parseTaskType } from '@/lib/tasks/task-config';
import {
  buildTaskCardGroupsStorageKey,
  consolidateSyncedTaskCardGroups,
  LIST_CARD_GROUPS_SCOPE,
  loadTaskCardGroups,
  mergeSyncedTaskCardGroups,
  type TaskCardGroup,
} from '@/features/tasks/utils/task-card-groups';
import { useTaskCardGroupsSyncStore } from '@/features/tasks/task-card-groups-sync-store';
import { buildTaskListNavigation } from '@/features/tasks/utils/task-list-navigation';
import {
  buildTaskDetailHref,
  normalizeTaskListReturnHref,
} from '@/features/tasks/utils/task-navigation';

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';
const TASK_SWITCH_ANIMATION_MS = 220;

type TaskSwitchDirection = 'forward' | 'backward';
type TaskSwipeState = Pick<TitleSwipeProgress, 'progress' | 'isDragging'>;

const subscribeToDesktopViewport = (onStoreChange: () => void) => {
  if (typeof window === 'undefined') return () => {};
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

const buildTaskListHref = (projectId?: string | null) => {
  const normalizedProjectId = projectId?.trim();
  if (!normalizedProjectId) {
    return '/app/tasks';
  }
  return `/app/tasks?projectId=${encodeURIComponent(normalizedProjectId)}`;
};

export default function TaskDetailPage() {
  const params = useParams();
  const { push, replace } = useRouter();
  const searchParams = useSearchParams();
  const taskId = params.taskId as string;
  const tasks = useTasksStore((state) => state.tasks);
  const task = tasks.find((item) => item.id === taskId);
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const userId = useAuthStore((state) => state.session?.user.id ?? null);
  const runningOnly = useUserPreferencesStore((state) => state.taskListRunningOnly);
  const syncedGroupsSnapshot = useTaskCardGroupsSyncStore((state) => state.snapshot);
  const taskCardGroupsHydrated = useTaskCardGroupsSyncStore((state) => state.hydrated);
  const hydrateTaskCardGroups = useTaskCardGroupsSyncStore((state) => state.hydrate);
  const isDesktop = useSyncExternalStore(
    subscribeToDesktopViewport,
    getDesktopViewportSnapshot,
    () => false,
  );
  const [taskCardGroups, setTaskCardGroups] = useState<TaskCardGroup[]>([]);
  const [taskSwitchAnimation, setTaskSwitchAnimation] = useState<TaskSwitchDirection | null>(null);
  const [taskSwipeState, setTaskSwipeState] = useState<TaskSwipeState>({
    progress: 0,
    isDragging: false,
  });
  const taskSwitchAnimationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backProjectId = task?.projectId || selectedProjectId;
  const returnHref = normalizeTaskListReturnHref(searchParams.get('from')) ?? buildTaskListHref(backProjectId);
  const returnSearchParams = useMemo(() => {
    const queryIndex = returnHref.indexOf('?');
    return new URLSearchParams(queryIndex >= 0 ? returnHref.slice(queryIndex + 1) : '');
  }, [returnHref]);
  const projectId = returnSearchParams.get('projectId');
  const projectGroups = useMemo(() => computeProjectGroups(projects), [projects]);
  const currentProjectGroup = useMemo(() => (
    projectId
      ? projectGroups.find((group) => group.members.some((member) => member.id === projectId)) ?? null
      : null
  ), [projectGroups, projectId]);
  const projectScope = useMemo(() => {
    if (currentProjectGroup?.isMerged) {
      return currentProjectGroup.members.map((member) => member.id);
    }
    return projectId ? [projectId] : [];
  }, [currentProjectGroup, projectId]);
  // Tab cards are a single global set (see LIST_CARD_GROUPS_SCOPE), so the
  // detail-page navigation must read the same scope TaskList writes to —
  // keying by the active project filter would miss merges made elsewhere.
  const groupsStorageKey = useMemo(
    () => buildTaskCardGroupsStorageKey(LIST_CARD_GROUPS_SCOPE, userId),
    [userId],
  );
  const projectDaemonHostMap = useMemo(() => new Map(
    projects.map((project) => [project.id, project.daemonHost ?? null] as const),
  ), [projects]);
  const taskTypeFilter = parseTaskType(returnSearchParams.get('taskType'));
  const daemonHostFilter = returnSearchParams.get('daemonHost')?.trim() || null;
  const backendFilter = returnSearchParams.get('backend')?.trim() || null;
  const returnsToListView = returnSearchParams.get('view') !== 'graph';

  useEffect(() => {
    if (userId) void hydrateTaskCardGroups(userId);
  }, [hydrateTaskCardGroups, userId]);

  // Navigation must see the same global tab-card set the list edits. Prefer the
  // synced snapshot (so a cold deep-link to a task detail still gets merged-tab
  // navigation without visiting the list first) and fall back to this device's
  // local cache when nothing has synced yet. The snapshot's scopes are folded
  // into one set for the same reason the list folds them.
  useEffect(() => {
    const local = loadTaskCardGroups(groupsStorageKey);
    if (!userId || !taskCardGroupsHydrated || Object.keys(syncedGroupsSnapshot.scopes).length === 0) {
      setTaskCardGroups(local);
      return;
    }
    const consolidated = consolidateSyncedTaskCardGroups([
      syncedGroupsSnapshot.scopes[LIST_CARD_GROUPS_SCOPE] ?? [],
      ...Object.entries(syncedGroupsSnapshot.scopes)
        .filter(([scope]) => scope !== LIST_CARD_GROUPS_SCOPE)
        .map(([, groups]) => groups),
    ]);
    setTaskCardGroups(mergeSyncedTaskCardGroups(local, consolidated));
  }, [groupsStorageKey, syncedGroupsSnapshot, taskCardGroupsHydrated, userId]);

  useEffect(() => () => {
    if (taskSwitchAnimationTimeoutRef.current !== null) {
      clearTimeout(taskSwitchAnimationTimeoutRef.current);
    }
  }, []);

  const navigation = useMemo(() => buildTaskListNavigation(tasks, taskCardGroups, {
    projectFilter: projectScope.length > 0 ? projectScope : null,
    hiddenProjectIds,
    runningOnly,
    taskTypeFilter,
    daemonHostFilter,
    backendFilter,
    projectDaemonHostMap,
  }), [
    backendFilter,
    daemonHostFilter,
    hiddenProjectIds,
    projectDaemonHostMap,
    projectScope,
    runningOnly,
    taskCardGroups,
    taskTypeFilter,
    tasks,
  ]);
  const navigationAnchorTaskId = navigation.activeTaskIdByTaskId.get(taskId) ?? taskId;
  const currentTaskIndex = navigation.tasks.findIndex((item) => item.id === navigationAnchorTaskId);
  const previousTask = currentTaskIndex > 0 ? navigation.tasks[currentTaskIndex - 1] ?? null : null;
  const nextTask = currentTaskIndex >= 0 && currentTaskIndex < navigation.tasks.length - 1
    ? navigation.tasks[currentTaskIndex + 1] ?? null
    : null;
  const canSwipeTaskTitle = !isDesktop && returnsToListView && currentTaskIndex >= 0;

  const handleTaskTitleSwipe = useCallback((offset: -1 | 1) => {
    const targetTask = navigation.tasks[currentTaskIndex + offset];
    if (!targetTask) return;

    const direction: TaskSwitchDirection = offset > 0 ? 'forward' : 'backward';
    setTaskSwitchAnimation(direction);
    if (taskSwitchAnimationTimeoutRef.current !== null) {
      clearTimeout(taskSwitchAnimationTimeoutRef.current);
    }
    taskSwitchAnimationTimeoutRef.current = setTimeout(() => {
      setTaskSwitchAnimation(null);
      taskSwitchAnimationTimeoutRef.current = null;
    }, TASK_SWITCH_ANIMATION_MS);
    replace(buildTaskDetailHref(targetTask.id, returnHref), { scroll: false });
  }, [currentTaskIndex, navigation.tasks, replace, returnHref]);

  const handleTaskTitleSwipeProgress = useCallback((state: TitleSwipeProgress) => {
    setTaskSwipeState({
      progress: state.progress,
      isDragging: state.isDragging,
    });
  }, []);

  useEffect(() => {
    if (canSwipeTaskTitle || (taskSwipeState.progress === 0 && !taskSwipeState.isDragging)) {
      return;
    }
    setTaskSwipeState({ progress: 0, isDragging: false });
  }, [canSwipeTaskTitle, taskSwipeState.isDragging, taskSwipeState.progress]);

  return (
    <Suspense fallback={null}>
      <TaskDetailPane
        taskId={taskId}
        showBack
        onBack={() => push(returnHref)}
        showConnectionStatus
        onTitleSwipeLeft={canSwipeTaskTitle && nextTask
          ? () => handleTaskTitleSwipe(1)
          : undefined}
        onTitleSwipeRight={canSwipeTaskTitle && previousTask
          ? () => handleTaskTitleSwipe(-1)
          : undefined}
        onTitleSwipeProgress={canSwipeTaskTitle ? handleTaskTitleSwipeProgress : undefined}
        titleSwipePreviewLeft={previousTask?.title ?? null}
        titleSwipePreviewRight={nextTask?.title ?? null}
        titleTransitionDirection={!isDesktop ? taskSwitchAnimation : null}
        titleSwipeState={!isDesktop && canSwipeTaskTitle ? taskSwipeState : undefined}
      />
    </Suspense>
  );
}

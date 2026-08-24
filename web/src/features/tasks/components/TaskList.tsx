'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { TaskType } from '@/lib/tasks/task-config';
import { orderTasksWithPinnedFirst, useTasksStore } from '../store';
import { useProjectsStore } from '@/features/projects';
import { useAuthStore } from '@/features/auth/store';
import {
  filterTasksByProject,
  getStableTaskBackend,
  resolveTaskDaemonHost,
  resolveTaskDisplayProjectId,
} from '../utils/task-filter';
import { taskCardSurfaceColor } from '../utils/task-card-surface';
import { TaskItem } from './TaskItem';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { TaskGraphView } from './TaskGraphView';
import type { Task } from '@/shared/types';
import {
  addTaskToGroup,
  buildTaskCardGroupsStorageKey,
  buildTaskCardRows,
  consolidateSyncedTaskCardGroups,
  createTaskCardGroup,
  ejectTaskFromGroup,
  LIST_CARD_GROUPS_SCOPE,
  loadTaskCardGroups,
  maxTaskCardGroupIdCounter,
  mergeSyncedTaskCardGroups,
  projectTaskCardGroups,
  saveTaskCardGroups,
  setActiveTaskCardTab,
  setTaskCardTabLabel,
  taskCardGroupsSyncKey,
  taskCardTabLabel,
  toSyncedTaskCardGroups,
  type TaskCardGroup,
} from '../utils/task-card-groups';
import { useTaskCardGroupsSyncStore } from '../task-card-groups-sync-store';
import { mapConcurrentSettled } from '@/shared/async/map-concurrent';

export type TaskListViewMode = 'list' | 'graph';

// Mouse/pen whole-card drag is claimed only after vertically dominant movement;
// touch uses the delayed activation below so normal tap, scroll, and swipe win
// unless the user deliberately holds the card first.
const DRAG_ACTIVATE_THRESHOLD = 6;
// Touch starts as an ordinary scroll/tap. Holding still for this duration
// promotes the same touch sequence into a merge drag.
const TOUCH_DRAG_ACTIVATE_MS = 450;
const TOUCH_DRAG_MOVE_TOLERANCE = 8;
// Press-and-hold duration that turns a tab press into an inline rename.
const TAB_LONG_PRESS_MS = 450;
const TASK_MUTATION_CONCURRENCY = 3;

type DragGhost = { taskId: string; title: string; x: number; y: number; width: number };
type RowDragState = {
  taskId: string;
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
  active: boolean;
  input: 'pointer' | 'touch';
};

const EmptyIcon = () => (
  <svg className="size-16 text-muted/30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

const SelectionIcon = ({ allSelected }: { allSelected: boolean }) => (
  <svg
    aria-hidden="true"
    className="size-4"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <rect x="4" y="4" width="16" height="16" rx="3" strokeWidth={2} />
    {allSelected ? (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m8 12 2.5 2.5L16 9" />
    ) : (
      <path strokeLinecap="round" strokeWidth={2} d="M8 12h8" />
    )}
  </svg>
);

const ArchiveIcon = () => (
  <svg
    aria-hidden="true"
    className="size-4"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7h18M4 7l1 12a2 2 0 002 2h10a2 2 0 002-2l1-12M9 11h6" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7l2-3h12l2 3" />
  </svg>
);

const TrashIcon = () => (
  <svg
    aria-hidden="true"
    className="size-4"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

const BusyIcon = () => (
  <svg
    aria-hidden="true"
    className="size-4 animate-spin"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
    <path className="opacity-75" fill="currentColor" d="M12 3a9 9 0 0 1 9 9h-3a6 6 0 0 0-6-6V3Z" />
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
  /**
   * Either a single projectId, or — for the cross-daemon merged-project
   * view — every member projectId in the active group. The list filters
   * tasks to whichever scope is provided.
   */
  projectFilter?: string | string[] | null;
  runningOnly?: boolean;
  taskTypeFilter?: TaskType | null;
  daemonHostFilter?: string | null;
  backendFilter?: string | null;
  onFilterByTaskType?: (taskType: TaskType) => void;
  onFilterByProject?: (projectId: string) => void;
  onFilterByDaemonHost?: (daemonHost: string) => void;
  onFilterByBackend?: (backend: string) => void;
}

export function TaskList({
  viewMode,
  activeTaskId = null,
  onOpenTask,
  desktopListPaneMode = false,
  projectFilter,
  runningOnly = false,
  taskTypeFilter = null,
  daemonHostFilter = null,
  backendFilter = null,
  onFilterByTaskType,
  onFilterByProject,
  onFilterByDaemonHost,
  onFilterByBackend,
}: TaskListProps) {
  const {
    tasks,
    isLoading,
    unreadTaskIds,
    currentProjectFilter,
    deleteTask,
    achieveTask,
  } = useTasksStore();
  const userId = useAuthStore((state) => state.session?.user.id ?? null);
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const syncedGroupsSnapshot = useTaskCardGroupsSyncStore((state) => state.snapshot);
  const taskCardGroupsHydrated = useTaskCardGroupsSyncStore((state) => state.hydrated);
  const hydrateTaskCardGroups = useTaskCardGroupsSyncStore((state) => state.hydrate);
  const saveTaskCardGroupsScope = useTaskCardGroupsSyncStore((state) => state.saveScope);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [isArchivingSelected, setIsArchivingSelected] = useState(false);
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{
    action: 'Archiving' | 'Deleting';
    completed: number;
    total: number;
  } | null>(null);
  const [groups, setGroups] = useState<TaskCardGroup[]>([]);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dragGhost, setDragGhost] = useState<DragGhost | null>(null);
  const [editingTab, setEditingTab] = useState<{ groupId: string; taskId: string } | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const itemWrapperRefs = useRef(new Map<string, HTMLDivElement>());
  const rowRefs = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<RowDragState | null>(null);
  const touchDragTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nativeTouchMoveHandlerRef = useRef<(event: TouchEvent) => void>(() => {});
  const justDraggedRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const groupIdCounterRef = useRef(0);
  const skipGroupSaveRef = useRef(false);
  const lastSyncedGroupsKeyRef = useRef<string | null>(null);
  const attemptedLegacySyncScopesRef = useRef(new Set<string>());
  const previousRectsRef = useRef(new Map<string, DOMRect>());
  const previousOrderRef = useRef<string[]>([]);
  const animationFrameRef = useRef<number | null>(null);
  const effectiveProjectFilter: string | string[] | null =
    projectFilter !== undefined ? projectFilter : currentProjectFilter;
  // Hide PTY tasks that are bound to an AI task via AttachedTerminal. The
  // server-side list endpoint already excludes them, but a single-task fetch
  // (e.g. opening the PTY view in TaskDetailPane triggers an /api/tasks/[id]
  // call that may land in the store via fetchTask) can re-introduce the
  // row. This defensive filter ensures both the rendered list AND the
  // header count derived in tasks/page.tsx agree.
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
    () => filterTasksByProject(tasksWithoutAttachedPty, effectiveProjectFilter, hiddenProjectIds),
    [tasksWithoutAttachedPty, effectiveProjectFilter, hiddenProjectIds],
  );
  // Normalize the filter to an id list so derived rendering helpers can treat
  // single- and merged-group cases uniformly.
  const effectiveProjectFilterIds = useMemo(() => {
    if (!effectiveProjectFilter) return [] as string[];
    return Array.isArray(effectiveProjectFilter)
      ? effectiveProjectFilter.filter(Boolean)
      : [effectiveProjectFilter];
  }, [effectiveProjectFilter]);
  const graphStateKey = useMemo(() => {
    const projectScope = effectiveProjectFilterIds.length > 0
      ? [...effectiveProjectFilterIds].sort().join(',')
      : 'all';
    return `projects:${projectScope}`;
  }, [effectiveProjectFilterIds]);
  // Tab-cards are global, not per project filter (see LIST_CARD_GROUPS_SCOPE),
  // so their storage key is independent of `graphStateKey` (which stays
  // per-project for the graph canvas layout).
  const groupsStorageKey = useMemo(
    () => buildTaskCardGroupsStorageKey(LIST_CARD_GROUPS_SCOPE, userId),
    [userId],
  );
  const legacyGroupsStorageKey = useMemo(
    () => buildTaskCardGroupsStorageKey(LIST_CARD_GROUPS_SCOPE),
    [],
  );
  const isMergedScope = effectiveProjectFilterIds.length > 1;
  const runningFilteredTasks = useMemo(
    () => runningOnly
      ? projectVisibleTasks.filter((task) => task.status === 'running' || task.status === 'killing')
      : projectVisibleTasks,
    [projectVisibleTasks, runningOnly],
  );
  const typeFilteredTasks = useMemo(
    () => taskTypeFilter
      ? runningFilteredTasks.filter((task) => (task.taskType ?? 'ai_task') === taskTypeFilter)
      : runningFilteredTasks,
    [runningFilteredTasks, taskTypeFilter],
  );

  const projectMap = useMemo(() => {
    const map = new Map<
      string,
      { name: string; daemonHost: string | null }
    >();
    for (const project of projects) {
      map.set(project.id, {
        name: project.name,
        daemonHost: project.daemonHost ?? null,
      });
    }
    return map;
  }, [projects]);
  // Project-keyed daemon-host map for the resolver. The resolver itself
  // prefers `task.metadata.daemonName` so this fallback only kicks in when
  // the task's metadata is missing.
  const projectDaemonHostMap = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const project of projects) {
      map.set(project.id, project.daemonHost ?? null);
    }
    return map;
  }, [projects]);
  const daemonFilteredTasks = useMemo(
    () => daemonHostFilter
      ? typeFilteredTasks.filter((task) => resolveTaskDaemonHost(task, projectDaemonHostMap) === daemonHostFilter)
      : typeFilteredTasks,
    [typeFilteredTasks, daemonHostFilter, projectDaemonHostMap],
  );
  const backendFilteredTasks = useMemo(
    () => backendFilter
      ? daemonFilteredTasks.filter((task) => getStableTaskBackend(task) === backendFilter)
      : daemonFilteredTasks,
    [daemonFilteredTasks, backendFilter],
  );
  const visibleTasks = useMemo(
    () => orderTasksWithPinnedFirst(backendFilteredTasks),
    [backendFilteredTasks],
  );

  // Two independent visibility rules — historically they were a single
  // `showProjectInfo` flag, but the project-name chip and the daemon-host
  // chip carry different signals:
  //
  //  - Project name: useful only when tasks could belong to *different*
  //    projects. That happens in the no-filter "all tasks" view; in a
  //    single-project or merged-cross-daemon view every visible task shares
  //    the same project name (the merge criterion), so the chip is redundant.
  //  - Daemon host: useful whenever tasks could come from *different*
  //    daemons. Three triggers:
  //      • no project filter at all (different projects → different daemons);
  //      • merged cross-daemon project group (the canonical case for
  //        bound projects with the same name on multiple daemons);
  //      • single-project view whose tasks span multiple daemons — this
  //        applies to the server-side "Default Project", which has no
  //        per-daemon binding so it can't go through the merge path, but
  //        accumulates tasks from every daemon (with `metadata.daemonName`
  //        recording the true owner). Detection runs on `typeFilteredTasks`
  //        (i.e. *before* the daemon-host filter) so the chip stays
  //        visible after the user clicks it to filter — otherwise the
  //        very control that activated the filter would vanish.
  const visibleTasksSpanMultipleDaemons = useMemo(() => {
    const seen = new Set<string>();
    for (const task of typeFilteredTasks) {
      const host = resolveTaskDaemonHost(task, projectDaemonHostMap);
      if (!host) continue;
      seen.add(host);
      if (seen.size > 1) return true;
    }
    return false;
  }, [typeFilteredTasks, projectDaemonHostMap]);
  const showProjectName = effectiveProjectFilterIds.length === 0;
  const showDaemonHost =
    effectiveProjectFilterIds.length === 0
    || isMergedScope
    || visibleTasksSpanMultipleDaemons;
  // For the merged-group case every member has the same name, so the first
  // member's name is a faithful header label.
  const currentProjectName = effectiveProjectFilterIds.length > 0
    ? projects.find((project) => project.id === effectiveProjectFilterIds[0])?.name
    : null;
  const allTaskIds = useMemo(() => visibleTasks.map((task) => task.id), [visibleTasks]);
  const visibleTaskIdSet = useMemo(() => new Set(allTaskIds), [allTaskIds]);
  // Track the latest visible-id set in a ref so `toggleTaskSelection` can read
  // it without listing it as a dependency. `visibleTaskIdSet` gets a new
  // reference on every WebSocket update (the tasks array is replaced), so
  // depending on it would give `onToggleSelect` a new identity each time and
  // defeat the TaskItem memo for every card. The ref is updated in an effect
  // (after commit) rather than during render, which is safe under concurrent
  // rendering and only ever read at click time.
  const visibleTaskIdSetRef = useRef(visibleTaskIdSet);
  useEffect(() => {
    visibleTaskIdSetRef.current = visibleTaskIdSet;
  }, [visibleTaskIdSet]);
  const visibleTaskById = useMemo(
    () => new Map(visibleTasks.map((task) => [task.id, task] as const)),
    [visibleTasks],
  );
  // Tab-card grouping only applies to the list view; the graph view has its own
  // free-canvas merge model. Groups are projected onto the visible tasks so
  // filtered-out tabs disappear without mutating the stored membership.
  const renderGroups = useMemo(
    () => (viewMode === 'list'
      ? projectTaskCardGroups(groups, (taskId) => visibleTaskIdSet.has(taskId))
      : []),
    [groups, viewMode, visibleTaskIdSet],
  );
  const activeTaskStoredGroup = useMemo(
    () => activeTaskId
      ? groups.find((group) => group.taskIds.includes(activeTaskId)) ?? null
      : null,
    [activeTaskId, groups],
  );
  const groupIdSet = useMemo(() => new Set(renderGroups.map((group) => group.id)), [renderGroups]);
  const taskCardRows = useMemo(
    () => buildTaskCardRows(visibleTasks, renderGroups),
    [visibleTasks, renderGroups],
  );
  const selectedTaskIdSet = useMemo(() => new Set(
    [...selectedTaskIds].filter((taskId) => visibleTaskIdSet.has(taskId)),
  ), [selectedTaskIds, visibleTaskIdSet]);
  const selectedCount = selectedTaskIdSet.size;
  const selectionMode = selectedCount > 0 || batchProgress !== null;
  const hasToolbarContent = viewMode === 'list' && selectionMode;
  const allSelected = allTaskIds.length > 0 && selectedCount === allTaskIds.length;
  const selectedTasksAreArchivable = useMemo(
    () => [...selectedTaskIdSet].every(
      (taskId) => (visibleTaskById.get(taskId)?.taskType ?? 'ai_task') === 'ai_task',
    ),
    [selectedTaskIdSet, visibleTaskById],
  );
  const selectionActionBusy = isArchivingSelected || isDeletingSelected;

  useEffect(() => (
    () => {
      if (animationFrameRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
      if (longPressTimerRef.current !== null) {
        clearTimeout(longPressTimerRef.current);
      }
      if (touchDragTimerRef.current !== null) {
        clearTimeout(touchDragTimerRef.current);
      }
    }
  ), []);

  // Match dnd-kit's TouchSensor setup: the non-passive listener must exist
  // before the gesture begins so a post-long-press move remains cancelable.
  useEffect(() => {
    const handleTouchMove = (event: TouchEvent) => nativeTouchMoveHandlerRef.current(event);
    window.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => window.removeEventListener('touchmove', handleTouchMove);
  }, []);

  useEffect(() => {
    if (viewMode === 'graph' && selectedTaskIds.size > 0) {
      setSelectedTaskIds(new Set());
    }
  }, [selectedTaskIds.size, viewMode]);

  // A deep link or freshly-created branch can select a task before its
  // synchronized tab card reaches this component. Once the group arrives,
  // bring that task's tab to the front so the list and detail pane agree.
  useEffect(() => {
    if (
      !activeTaskId
      || !activeTaskStoredGroup
      || activeTaskStoredGroup.taskIds[activeTaskStoredGroup.activeIndex] === activeTaskId
    ) {
      return;
    }
    setGroups((current) =>
      setActiveTaskCardTab(current, activeTaskStoredGroup.id, activeTaskId),
    );
  }, [activeTaskId, activeTaskStoredGroup]);

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
      viewMode === 'list' &&
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

        Object.assign(node.style, {
          transition: 'none',
          transform: `translate(${deltaX}px, ${deltaY}px)`,
          willChange: 'transform',
        });
        animatedNodes.push(node);
      });

      if (animatedNodes.length > 0 && typeof window !== 'undefined') {
        if (animationFrameRef.current !== null) {
          window.cancelAnimationFrame(animationFrameRef.current);
        }
        animationFrameRef.current = window.requestAnimationFrame(() => {
          animatedNodes.forEach((node) => {
            Object.assign(node.style, {
              transition: `transform ${TASK_REORDER_ANIMATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
              transform: '',
            });
          });
          animationFrameRef.current = null;
        });
      }
    }

    previousRectsRef.current = currentRects;
    previousOrderRef.current = [...allTaskIds];
  }, [allTaskIds, desktopListPaneMode, viewMode]);

  // Load persisted tab cards for the active project scope; seed the id counter
  // above every stored id so a fresh id can never collide with an existing one.
  useEffect(() => {
    let loaded = loadTaskCardGroups(groupsStorageKey);
    // One-time migration from the pre-sync, non-user-scoped cache. Moving the
    // entry prevents a second account on the same browser from importing it.
    if (
      userId
      && typeof window !== 'undefined'
      && window.localStorage.getItem(groupsStorageKey) === null
      && window.localStorage.getItem(legacyGroupsStorageKey) !== null
    ) {
      loaded = loadTaskCardGroups(legacyGroupsStorageKey);
      saveTaskCardGroups(groupsStorageKey, loaded);
      window.localStorage.removeItem(legacyGroupsStorageKey);
    }
    skipGroupSaveRef.current = true;
    lastSyncedGroupsKeyRef.current = null;
    groupIdCounterRef.current = maxTaskCardGroupIdCounter(loaded);
    setGroups(loaded);
    setEditingTab(null);
  }, [groupsStorageKey, legacyGroupsStorageKey, userId]);

  useEffect(() => {
    if (userId) void hydrateTaskCardGroups(userId);
  }, [hydrateTaskCardGroups, userId]);

  // Server scopes are authoritative, including an empty-array tombstone. Tab
  // cards are global, so fold *every* project scope into one working set — a
  // card merged under a specific project (an older per-project scope) then
  // stays visible in every view, not just the project it was created in. The
  // global scope is folded first so, on id collision, its device-active tab
  // wins and the union is stable across reloads. If nothing has ever synced,
  // upload this device's legacy cache once so existing users keep their cards.
  useEffect(() => {
    if (!userId || !taskCardGroupsHydrated) return;
    const scopes = syncedGroupsSnapshot.scopes;
    const migrationKey = `${userId}:${LIST_CARD_GROUPS_SCOPE}`;
    const hasServerScopes = Object.keys(scopes).length > 0;

    if (!hasServerScopes) {
      if (attemptedLegacySyncScopesRef.current.has(migrationKey)) return;
      attemptedLegacySyncScopesRef.current.add(migrationKey);
      const localGroups = loadTaskCardGroups(groupsStorageKey);
      if (localGroups.length === 0) return;
      const syncKey = taskCardGroupsSyncKey(localGroups);
      lastSyncedGroupsKeyRef.current = syncKey;
      void saveTaskCardGroupsScope(userId, LIST_CARD_GROUPS_SCOPE, localGroups).then((saved) => {
        if (!saved && lastSyncedGroupsKeyRef.current === syncKey) {
          lastSyncedGroupsKeyRef.current = null;
          attemptedLegacySyncScopesRef.current.delete(migrationKey);
        }
      });
      return;
    }

    attemptedLegacySyncScopesRef.current.add(migrationKey);
    const hasGlobalScope = Object.prototype.hasOwnProperty.call(
      scopes,
      LIST_CARD_GROUPS_SCOPE,
    );
    const consolidated = consolidateSyncedTaskCardGroups([
      // When the server has no global scope yet (an older server, or before its
      // lazy collapse of legacy scopes runs), fold this device's local cache in
      // first so merges made offline / before sign-in survive. Once the server
      // holds an (even empty) global scope it is authoritative and local-only
      // cards must not resurrect ones dissolved on another device.
      ...(hasGlobalScope ? [] : [toSyncedTaskCardGroups(loadTaskCardGroups(groupsStorageKey))]),
      scopes[LIST_CARD_GROUPS_SCOPE] ?? [],
      ...Object.entries(scopes)
        .filter(([scope]) => scope !== LIST_CARD_GROUPS_SCOPE)
        .map(([, groups]) => groups),
    ]);
    // A server global scope is authoritative → mark it synced to suppress the
    // echo upload. When it is still absent, the folded union carries local-only
    // / legacy cards not yet under the global scope, so leave the sync marker
    // clear and let the save effect upload the merged result.
    if (hasGlobalScope) {
      lastSyncedGroupsKeyRef.current = taskCardGroupsSyncKey(consolidated);
    }
    setGroups((current) => {
      const next = mergeSyncedTaskCardGroups(current, consolidated);
      if (JSON.stringify(next) === JSON.stringify(current)) return current;
      if (hasGlobalScope) skipGroupSaveRef.current = true;
      groupIdCounterRef.current = maxTaskCardGroupIdCounter(next);
      saveTaskCardGroups(groupsStorageKey, next);
      return next;
    });
  }, [
    groupsStorageKey,
    saveTaskCardGroupsScope,
    syncedGroupsSnapshot,
    taskCardGroupsHydrated,
    userId,
  ]);

  useEffect(() => {
    if (skipGroupSaveRef.current) {
      skipGroupSaveRef.current = false;
      return;
    }
    saveTaskCardGroups(groupsStorageKey, groups);
    if (!userId) return;
    const syncKey = taskCardGroupsSyncKey(groups);
    if (lastSyncedGroupsKeyRef.current === syncKey) return;
    lastSyncedGroupsKeyRef.current = syncKey;
    void saveTaskCardGroupsScope(userId, LIST_CARD_GROUPS_SCOPE, groups).then((saved) => {
      if (!saved && lastSyncedGroupsKeyRef.current === syncKey) {
        lastSyncedGroupsKeyRef.current = null;
      }
    });
  }, [groups, groupsStorageKey, saveTaskCardGroupsScope, userId]);

  // Drop an in-progress rename once its tab stops being an editable rendered tab
  // (group dissolved, or its task filtered out) so the edit box can't linger.
  useEffect(() => {
    setEditingTab((current) => {
      if (!current) return current;
      const group = renderGroups.find((candidate) => candidate.id === current.groupId);
      return group && group.taskIds.includes(current.taskId) ? current : null;
    });
  }, [renderGroups]);

  const setRowRef = (rowId: string, isTaskRow: boolean) => (node: HTMLElement | null) => {
    if (node) {
      rowRefs.current.set(rowId, node);
      if (isTaskRow) itemWrapperRefs.current.set(rowId, node as HTMLDivElement);
      return;
    }
    rowRefs.current.delete(rowId);
    if (isTaskRow) itemWrapperRefs.current.delete(rowId);
  };

  // `useCallback` so the `onToggleSelect` prop stays referentially stable —
  // otherwise every TaskList render hands each memoized TaskItem a new function
  // and defeats the memo.
  const toggleTaskSelection = useCallback((taskId: string) => {
    if (selectionActionBusy) {
      return;
    }
    setSelectedTaskIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleTaskIdSetRef.current.has(id)));
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, [selectionActionBusy]);

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedTaskIds(new Set());
      return;
    }
    setSelectedTaskIds(new Set(allTaskIds));
  };

  const handleBatchArchive = async () => {
    if (
      selectedTaskIdSet.size === 0
      || !selectedTasksAreArchivable
      || selectionActionBusy
    ) {
      return;
    }
    const taskIds = [...selectedTaskIdSet];
    const taskNoun = taskIds.length === 1 ? 'task' : 'tasks';
    const accepted = await confirm({
      title: `Archive ${taskIds.length} selected ${taskNoun}?`,
      description:
        'Their live sessions will be closed, but their chat histories will remain searchable in Settings → Achieved tasks.',
      confirmLabel: 'Archive',
    });
    if (!accepted) {
      return;
    }

    setIsArchivingSelected(true);
    try {
      setBatchProgress({ action: 'Archiving', completed: 0, total: taskIds.length });
      const results = await mapConcurrentSettled(
        taskIds,
        TASK_MUTATION_CONCURRENCY,
        (taskId) => achieveTask(taskId),
        (completed, total) => {
          setBatchProgress({ action: 'Archiving', completed, total });
        },
      );
      const failedTaskIds = taskIds.filter(
        (_, index) => results[index]?.status === 'rejected',
      );
      const archivedCount = taskIds.length - failedTaskIds.length;
      setSelectedTaskIds(new Set(failedTaskIds));

      if (failedTaskIds.length > 0) {
        const firstFailure = results.find((result) => result.status === 'rejected');
        const description = firstFailure?.status === 'rejected'
          && firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : 'Some selected tasks could not be archived.';
        pushToast({
          title: archivedCount > 0
            ? `${archivedCount} archived, ${failedTaskIds.length} failed`
            : 'Failed to archive selected tasks',
          description,
          variant: 'error',
        });
        return;
      }

      pushToast({
        title: `${taskIds.length} ${taskNoun} archived`,
        description: 'Their chat histories are available in Settings → Achieved tasks.',
        variant: 'success',
      });
    } finally {
      setIsArchivingSelected(false);
      setBatchProgress(null);
    }
  };

  const handleBatchDelete = async () => {
    if (selectedTaskIdSet.size === 0 || selectionActionBusy) {
      return;
    }
    const accepted = await confirm({
      title: `Delete ${selectedTaskIdSet.size} selected task(s)?`,
      description: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!accepted) {
      return;
    }

    const taskIds = [...selectedTaskIdSet];
    setIsDeletingSelected(true);
    setBatchProgress({ action: 'Deleting', completed: 0, total: taskIds.length });
    try {
      const results = await mapConcurrentSettled(
        taskIds,
        TASK_MUTATION_CONCURRENCY,
        (taskId) => deleteTask(taskId),
        (completed, total) => {
          setBatchProgress({ action: 'Deleting', completed, total });
        },
      );
      const failedTaskIds = taskIds.filter(
        (_, index) => results[index]?.status === 'rejected',
      );
      const deletedCount = taskIds.length - failedTaskIds.length;
      setSelectedTaskIds(new Set(failedTaskIds));

      if (failedTaskIds.length > 0) {
        const firstFailure = results.find((result) => result.status === 'rejected');
        const description = firstFailure?.status === 'rejected'
          && firstFailure.reason instanceof Error
          ? firstFailure.reason.message
          : 'Some selected tasks could not be deleted.';
        pushToast({
          title: deletedCount > 0
            ? `${deletedCount} deleted, ${failedTaskIds.length} failed`
            : 'Failed to delete selected tasks',
          description,
          variant: 'error',
        });
        return;
      }

      pushToast({
        title: `${taskIds.length} task${taskIds.length === 1 ? '' : 's'} deleted`,
        variant: 'success',
      });
    } finally {
      setIsDeletingSelected(false);
      setBatchProgress(null);
    }
  };

  const nextGroupId = (): string => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `tabcard-${crypto.randomUUID()}`;
    }
    groupIdCounterRef.current += 1;
    return `tabcard-${Date.now()}-${groupIdCounterRef.current}`;
  };

  // Hit-test the pointer against every row except the dragged card. The list can
  // scroll, so we read live rects rather than caching them.
  const findRowIdAtPoint = (clientX: number, clientY: number, exceptId: string): string | null => {
    let found: string | null = null;
    rowRefs.current.forEach((node, rowId) => {
      if (rowId === exceptId) return;
      const rect = node.getBoundingClientRect();
      if (
        clientY >= rect.top && clientY <= rect.bottom
        && clientX >= rect.left && clientX <= rect.right
      ) {
        found = rowId;
      }
    });
    return found;
  };

  // Interactive descendants keep their own click/swipe behavior and never arm
  // a whole-card merge drag.
  const isInteractiveDragTarget = (target: EventTarget | null): boolean =>
    target instanceof Element
    && Boolean(target.closest('button, a, input, textarea, select, label, [contenteditable="true"]'));

  const clearTouchDragTimer = () => {
    if (touchDragTimerRef.current !== null) {
      clearTimeout(touchDragTimerRef.current);
      touchDragTimerRef.current = null;
    }
  };

  const activateRowDrag = (drag: RowDragState, clientX: number, clientY: number) => {
    if (dragRef.current !== drag || drag.active) return;
    drag.active = true;
    setDraggingTaskId(drag.taskId);
    const width = rowRefs.current.get(drag.taskId)?.getBoundingClientRect().width ?? 280;
    const title = visibleTaskById.get(drag.taskId)?.title ?? '';
    setDragGhost({
      taskId: drag.taskId,
      title,
      x: clientX - drag.offsetX,
      y: clientY - drag.offsetY,
      width,
    });
  };

  const updateActiveRowDrag = (drag: RowDragState, clientX: number, clientY: number) => {
    setDragGhost((current) => (current
      ? { ...current, x: clientX - drag.offsetX, y: clientY - drag.offsetY }
      : current));
    setDropTargetId(findRowIdAtPoint(clientX, clientY, drag.taskId));
  };

  const resetRowDrag = () => {
    clearTouchDragTimer();
    dragRef.current = null;
    setDraggingTaskId(null);
    setDropTargetId(null);
    setDragGhost(null);
  };

  const completeActiveRowDrag = (drag: RowDragState, clientX: number, clientY: number) => {
    justDraggedRef.current = true;
    const targetId = findRowIdAtPoint(clientX, clientY, drag.taskId);
    if (!targetId || targetId === drag.taskId) return;
    if (groupIdSet.has(targetId)) {
      setGroups((current) => addTaskToGroup(current, targetId, drag.taskId));
    } else {
      setGroups((current) => createTaskCardGroup(current, nextGroupId(), targetId, drag.taskId));
    }
  };

  const handleRowPointerDown = (event: ReactPointerEvent<HTMLDivElement>, taskId: string) => {
    justDraggedRef.current = false;
    if (event.button !== 0 || selectionMode) return;
    // Touch uses the delayed TouchEvent path below. Ignoring its companion
    // PointerEvent avoids competing state machines for the same finger.
    if (event.pointerType === 'touch') return;
    if (isInteractiveDragTarget(event.target)) return;
    const rect = rowRefs.current.get(taskId)?.getBoundingClientRect();
    dragRef.current = {
      taskId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: rect ? event.clientX - rect.left : 0,
      offsetY: rect ? event.clientY - rect.top : 0,
      active: false,
      input: 'pointer',
    };
  };

  const handleRowPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.input !== 'pointer' || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (!drag.active) {
      // Horizontal-dominant card motion belongs to TaskItem's swipe — bow out.
      if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > DRAG_ACTIVATE_THRESHOLD) {
        dragRef.current = null;
        return;
      }
      if (Math.abs(deltaY) < DRAG_ACTIVATE_THRESHOLD) return;
      activateRowDrag(drag, event.clientX, event.clientY);
    }
    event.preventDefault();
    updateActiveRowDrag(drag, event.clientX, event.clientY);
  };

  const handleRowPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.input !== 'pointer' || drag.pointerId !== event.pointerId) return;
    const wasActive = drag.active;
    resetRowDrag();
    if (!wasActive) return;
    completeActiveRowDrag(drag, event.clientX, event.clientY);
  };

  const handleRowPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.input !== 'pointer' || drag.pointerId !== event.pointerId) return;
    resetRowDrag();
  };

  const handleRowTouchStart = (event: ReactTouchEvent<HTMLDivElement>, taskId: string) => {
    justDraggedRef.current = false;
    clearTouchDragTimer();
    if (selectionMode || event.touches.length !== 1 || isInteractiveDragTarget(event.target)) return;
    const touch = event.touches[0];
    const rect = rowRefs.current.get(taskId)?.getBoundingClientRect();
    const drag: RowDragState = {
      taskId,
      pointerId: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      offsetX: rect ? touch.clientX - rect.left : 0,
      offsetY: rect ? touch.clientY - rect.top : 0,
      active: false,
      input: 'touch',
    };
    dragRef.current = drag;
    touchDragTimerRef.current = setTimeout(() => {
      touchDragTimerRef.current = null;
      activateRowDrag(drag, drag.startX, drag.startY);
    }, TOUCH_DRAG_ACTIVATE_MS);
  };

  nativeTouchMoveHandlerRef.current = (event: TouchEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.input !== 'touch') return;
    const touch = Array.from(event.touches).find((candidate) => candidate.identifier === drag.pointerId);
    if (!touch || event.touches.length !== 1) {
      resetRowDrag();
      return;
    }
    const deltaX = touch.clientX - drag.startX;
    const deltaY = touch.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(deltaX, deltaY) <= TOUCH_DRAG_MOVE_TOLERANCE) return;
      // Movement before the hold threshold is ordinary scroll/swipe. Do not
      // preventDefault: native scrolling and TaskItem gestures keep ownership.
      resetRowDrag();
      return;
    }
    if (event.cancelable) event.preventDefault();
    updateActiveRowDrag(drag, touch.clientX, touch.clientY);
  };

  const handleRowTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.input !== 'touch') return;
    const touch = Array.from(event.changedTouches).find(
      (candidate) => candidate.identifier === drag.pointerId,
    );
    if (!touch) return;
    const wasActive = drag.active;
    resetRowDrag();
    if (!wasActive) return;
    event.preventDefault();
    completeActiveRowDrag(drag, touch.clientX, touch.clientY);
  };

  const handleRowTouchCancel = () => {
    if (dragRef.current?.input === 'touch') resetRowDrag();
  };

  const handleRowContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (dragRef.current?.input === 'touch') event.preventDefault();
  };

  const handleRowClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (justDraggedRef.current) {
      justDraggedRef.current = false;
      event.stopPropagation();
      event.preventDefault();
    }
  };

  const handleSelectTab = (groupId: string, taskId: string) => {
    // Bring the tab's task to the top of the stack AND make it the selected task
    // so the active highlight and (desktop) detail pane follow the tab.
    setGroups((current) => setActiveTaskCardTab(current, groupId, taskId));
    onOpenTask?.(taskId);
  };

  const clearTabLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  // Tab gestures: click = select, press-and-hold = rename, double-click = un-merge.
  const handleTabPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    groupId: string,
    taskId: string,
    label: string,
  ) => {
    if (event.button !== 0) return;
    longPressFiredRef.current = false;
    clearTabLongPress();
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      beginTabEdit(groupId, taskId, label);
    }, TAB_LONG_PRESS_MS);
  };

  const handleTabClick = (groupId: string, taskId: string) => {
    // A press-and-hold already opened the rename box; swallow its trailing click.
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    handleSelectTab(groupId, taskId);
  };

  const handleTabDoubleClick = (groupId: string, taskId: string) => {
    clearTabLongPress();
    longPressFiredRef.current = false;
    handleEjectTab(groupId, taskId);
  };

  const beginTabEdit = (groupId: string, taskId: string, currentLabel: string) => {
    setEditingTab({ groupId, taskId });
    setEditingValue(currentLabel);
  };

  const commitTabEdit = () => {
    if (!editingTab) return;
    const { groupId, taskId } = editingTab;
    setGroups((current) => setTaskCardTabLabel(current, groupId, taskId, editingValue));
    setEditingTab(null);
    setEditingValue('');
  };

  const cancelTabEdit = () => {
    setEditingTab(null);
    setEditingValue('');
  };

  const handleEjectTab = (groupId: string, taskId: string) => {
    setGroups((current) => ejectTaskFromGroup(current, groupId, taskId));
    setEditingTab((current) => (current && current.taskId === taskId ? null : current));
  };

  const renderTaskItem = (task: Task) => {
    const projectEntry = projectMap.get(resolveTaskDisplayProjectId(task) ?? '');
    // Resolve the per-card daemon via the same fallback chain used by the filter
    // helpers so, e.g., Default-Project tasks still render their daemon chip.
    const taskDaemonHost = showDaemonHost
      ? resolveTaskDaemonHost(task, projectDaemonHostMap)
      : null;
    return (
      <TaskItem
        task={task}
        isUnread={unreadTaskIds.has(task.id)}
        isSelected={selectedTaskIds.has(task.id)}
        isActive={activeTaskId === task.id}
        selectionMode={selectionMode}
        onToggleSelect={toggleTaskSelection}
        onOpenTask={onOpenTask}
        desktopListPaneMode={desktopListPaneMode}
        showProjectName={showProjectName}
        showDaemonHost={showDaemonHost}
        projectName={showProjectName ? projectEntry?.name ?? null : null}
        projectDaemonHost={taskDaemonHost}
        activeTaskTypeFilter={taskTypeFilter}
        activeProjectFilter={isMergedScope ? null : (effectiveProjectFilterIds[0] ?? null)}
        activeDaemonHostFilter={daemonHostFilter}
        activeBackendFilter={backendFilter}
        onFilterByTaskType={onFilterByTaskType}
        onFilterByProject={onFilterByProject}
        onFilterByDaemonHost={onFilterByDaemonHost}
        onFilterByBackend={onFilterByBackend}
        isMergeDragging={draggingTaskId === task.id}
      />
    );
  };

  const taskTypeFilterLabel = taskTypeFilter === 'pty_task'
    ? 'PTY'
    : taskTypeFilter === 'ai_task'
      ? 'AI'
      : null;
  const hasDaemonTagFilter = Boolean(daemonHostFilter) && Boolean(onFilterByDaemonHost);
  const hasBackendTagFilter = Boolean(backendFilter) && Boolean(onFilterByBackend);
  const hasTagFilter = Boolean(taskTypeFilterLabel) || hasDaemonTagFilter || hasBackendTagFilter;
  const pillClassName =
    'inline-flex items-center gap-1 rounded bg-[var(--accent)]/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/20';
  const tagFilterBar = hasTagFilter ? (
    <div className="flex flex-wrap items-center gap-2">
      {taskTypeFilterLabel && onFilterByTaskType && taskTypeFilter ? (
        <button
          type="button"
          onClick={() => onFilterByTaskType(taskTypeFilter)}
          title={`Clear ${taskTypeFilterLabel} filter`}
          className={pillClassName}
        >
          <span>{taskTypeFilterLabel}</span>
          <span aria-hidden="true">✕</span>
          <span className="sr-only">Clear {taskTypeFilterLabel} filter</span>
        </button>
      ) : null}
      {hasDaemonTagFilter && daemonHostFilter && onFilterByDaemonHost ? (
        <button
          type="button"
          onClick={() => onFilterByDaemonHost(daemonHostFilter)}
          title={`Clear daemon filter (${daemonHostFilter})`}
          className={pillClassName}
        >
          <span className="max-w-[10rem] truncate">{daemonHostFilter}</span>
          <span aria-hidden="true">✕</span>
          <span className="sr-only">Clear daemon filter</span>
        </button>
      ) : null}
      {hasBackendTagFilter && backendFilter && onFilterByBackend ? (
        <button
          type="button"
          onClick={() => onFilterByBackend(backendFilter)}
          title={`Clear backend filter (${backendFilter})`}
          className={pillClassName}
        >
          <span className="max-w-[10rem] truncate">{backendFilter}</span>
          <span aria-hidden="true">✕</span>
          <span className="sr-only">Clear backend filter</span>
        </button>
      ) : null}
    </div>
  ) : null;
  const rootClassName = viewMode === 'graph'
    ? `flex h-full min-h-0 flex-col ${hasToolbarContent || tagFilterBar ? 'gap-4' : ''}`
    : hasToolbarContent || tagFilterBar
      ? 'space-y-4'
      : '';
  const renderGraphCanvas = (overlay?: ReactNode) => (
    <div className="min-h-0 flex-1">
      <div className="relative h-full min-h-[420px]">
        <TaskGraphView
          tasks={visibleTasks}
          activeTaskId={activeTaskId}
          onOpenTask={onOpenTask}
          stateKey={graphStateKey}
        />
        {overlay ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-6">
            {overlay}
          </div>
        ) : null}
      </div>
    </div>
  );

  if (isLoading && visibleTasks.length === 0) {
    if (viewMode === 'graph') {
      return (
        <div className={rootClassName}>
          {tagFilterBar}
          {renderGraphCanvas(
            <div className="rounded-lg bg-panel/90 p-4 shadow-sm">
              <LoadingSpinner size="lg" />
            </div>,
          )}
        </div>
      );
    }

    return (
      <div className="flex h-64 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (visibleTasks.length === 0 && batchProgress && viewMode === 'list') {
    return (
      <div
        aria-live="polite"
        className="flex h-72 items-center justify-center text-sm font-medium text-[var(--accent)]"
      >
        {batchProgress.action} {batchProgress.completed} of {batchProgress.total}
      </div>
    );
  }

  if (visibleTasks.length === 0) {
    const filterSummary = [
      taskTypeFilterLabel,
      hasBackendTagFilter && backendFilter ? backendFilter : null,
      hasDaemonTagFilter ? `daemon ${daemonHostFilter}` : null,
    ]
      .filter((value): value is string => Boolean(value))
      .join(' + ');
    const filterSuffix = filterSummary ? ` matching ${filterSummary}` : '';
    const emptyState = (
      <EmptyState
        className={viewMode === 'graph'
          ? 'pointer-events-auto max-w-lg border-border/60 bg-panel/90 shadow-sm'
          : 'h-72'}
        icon={<EmptyIcon />}
        title={
          hasTagFilter
            ? `No tasks${filterSuffix}`
            : runningOnly
              ? 'No running tasks'
              : 'No tasks yet'
        }
        description={
          hasTagFilter
            ? currentProjectName
              ? `No tasks${filterSuffix} in ${currentProjectName}. Adjust the tag filter to see more.`
              : `No tasks${filterSuffix}. Adjust the tag filter to see more.`
            : runningOnly
              ? currentProjectName
                ? `No running tasks found in ${currentProjectName}.`
                : 'No running tasks right now.'
              : currentProjectName
                ? `No tasks found in ${currentProjectName}. Switch projects or create a new task to start work here.`
                : 'Create your first task to start building with Conductor.'
        }
      />
    );

    if (viewMode === 'graph') {
      return (
        <div className={rootClassName}>
          {tagFilterBar}
          {renderGraphCanvas(emptyState)}
        </div>
      );
    }

    return (
      <div className={tagFilterBar ? 'space-y-3' : ''}>
        {tagFilterBar}
        {emptyState}
      </div>
    );
  }

  return (
    <div className={rootClassName}>
      {tagFilterBar}
      {hasToolbarContent ? (
        <div className="flex flex-col gap-3 rounded-2xl bg-panel/80 p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {selectionMode ? (
              <span
                aria-live="polite"
                className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]"
              >
                {batchProgress
                  ? `${batchProgress.action} ${batchProgress.completed} of ${batchProgress.total}`
                  : `${selectedCount} selected`}
              </span>
            ) : null}
          </div>

          <div
            role="toolbar"
            aria-label="Selected task actions"
            className="flex flex-wrap items-center gap-2"
          >
            {selectionMode ? (
              <>
                <button
                  type="button"
                  onClick={toggleSelectAll}
                  disabled={selectionActionBusy}
                  aria-label={allSelected ? 'Clear task selection' : 'Select all tasks'}
                  title={allSelected ? 'Clear selection' : 'Select all'}
                  className="inline-flex size-9 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-[var(--paper)] hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <SelectionIcon allSelected={allSelected} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleBatchArchive();
                  }}
                  disabled={selectionActionBusy || !selectedTasksAreArchivable}
                  aria-label={`Archive ${selectedCount} selected task${selectedCount === 1 ? '' : 's'}`}
                  title={selectedTasksAreArchivable
                    ? 'Archive selected tasks'
                    : 'Only AI tasks can be archived'}
                  className="inline-flex size-9 items-center justify-center rounded-lg border border-border text-muted transition-colors hover:bg-[var(--accent)]/10 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isArchivingSelected ? <BusyIcon /> : <ArchiveIcon />}
                </button>
                <button
                  type="button"
                  onClick={handleBatchDelete}
                  disabled={selectionActionBusy}
                  aria-label={`Delete ${selectedCount} selected task${selectedCount === 1 ? '' : 's'}`}
                  title="Delete selected tasks"
                  className="inline-flex size-9 items-center justify-center rounded-lg border border-[var(--error)]/30 text-[var(--error)] transition-colors hover:bg-[var(--error)]/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isDeletingSelected ? <BusyIcon /> : <TrashIcon />}
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {viewMode === 'graph' ? renderGraphCanvas() : (
        <div className={`space-y-3 ${draggingTaskId ? 'select-none' : ''}`}>
          {taskCardRows.map((row) => {
            if (row.type === 'task') {
              const task = row.task;
              const isDropTarget = dropTargetId === task.id;
              const isDragging = draggingTaskId === task.id;
              const dragProps = selectionMode ? {} : {
                onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => handleRowPointerDown(event, task.id),
                onPointerMove: handleRowPointerMove,
                onPointerUp: handleRowPointerUp,
                onPointerCancel: handleRowPointerCancel,
                onTouchStart: (event: ReactTouchEvent<HTMLDivElement>) => handleRowTouchStart(event, task.id),
                onTouchEnd: handleRowTouchEnd,
                onTouchCancel: handleRowTouchCancel,
                onContextMenu: handleRowContextMenu,
                onClickCapture: handleRowClickCapture,
              };
              return (
                <div
                  key={task.id}
                  ref={setRowRef(task.id, true)}
                  data-task-item-wrapper={task.id}
                  {...dragProps}
                  className={`relative cursor-grab touch-pan-y transition-all [-webkit-touch-callout:none] ${
                    isDragging ? 'cursor-grabbing opacity-40' : ''
                  }`}
                >
                  {renderTaskItem(task)}
                  {isDropTarget ? <DropHighlight /> : null}
                </div>
              );
            }

            const group = row.group;
            const activeTask = visibleTaskById.get(group.activeTaskId);
            if (!activeTask) return null;
            const isDropTarget = dropTargetId === group.id;
            // The active tab paints the card's current background so the strip
            // and card read as one selected surface. Inactive tabs keep the
            // card's resting background so selecting a task only highlights
            // the tab that owns the visible card.
            const cardSurfaceColor = taskCardSurfaceColor({
              desktopListPaneMode,
              selectionMode,
              isSelected: selectedTaskIds.has(activeTask.id),
              isActive: activeTaskId === activeTask.id,
            });
            const restingCardSurfaceColor = taskCardSurfaceColor({
              desktopListPaneMode,
              selectionMode,
            });
            return (
              <div
                key={group.id}
                ref={setRowRef(group.id, false)}
                data-task-tab-card={group.id}
                style={{
                  '--task-card-surface': cardSurfaceColor,
                  '--task-card-resting-surface': restingCardSurfaceColor,
                } as CSSProperties}
                className="relative"
              >
                {/* Tabs sit flush on the card's top edge (-mb-px overlaps the
                    border) and are nudged left so they clear the card's rounded
                    corner, reading as one attached unit. */}
                <div
                  role="tablist"
                  aria-label="Merged task tabs"
                  title="Click to open · hold to rename · double-click to unmerge"
                  className="relative z-[1] -mb-px ml-2 flex flex-wrap items-end gap-0.5 pl-1"
                >
                  {group.taskIds.map((taskId) => {
                    const tabTask = visibleTaskById.get(taskId);
                    if (!tabTask) return null;
                    const isActiveTab = taskId === group.activeTaskId;
                    const label = taskCardTabLabel(group, taskId);
                    const isEditing = editingTab?.groupId === group.id && editingTab.taskId === taskId;
                    return (
                      <div
                        key={taskId}
                        role="tab"
                        aria-selected={isActiveTab}
                        data-task-tab={taskId}
                        title={tabTask.title}
                        onPointerDown={(event) => handleTabPointerDown(event, group.id, taskId, label)}
                        onPointerUp={clearTabLongPress}
                        onPointerLeave={clearTabLongPress}
                        onPointerCancel={clearTabLongPress}
                        onClick={() => handleTabClick(group.id, taskId)}
                        onDoubleClick={() => handleTabDoubleClick(group.id, taskId)}
                        className={`flex shrink-0 cursor-pointer select-none items-center rounded-t-[10px] border border-[var(--border-default)] px-3 py-1.5 text-xs transition-colors ${
                          isActiveTab
                            ? 'border-b-transparent bg-[var(--task-card-surface,var(--surface-panel))] font-semibold text-[var(--accent)]'
                            : 'bg-[var(--task-card-resting-surface,var(--surface-panel))] font-medium text-muted hover:border-[var(--accent)] hover:text-ink'
                        }`}
                      >
                        {isEditing ? (
                          <input
                            data-task-tab-input={taskId}
                            autoFocus
                            value={editingValue}
                            onChange={(event) => setEditingValue(event.target.value)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitTabEdit();
                              } else if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelTabEdit();
                              }
                            }}
                            onBlur={commitTabEdit}
                            className="w-20 rounded bg-transparent text-xs text-current placeholder:text-current/60 focus:outline-none"
                          />
                        ) : (
                          <span className="max-w-[8rem] truncate">{label}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
                <div className="relative">
                  {renderTaskItem(activeTask)}
                  {isDropTarget ? <DropHighlight /> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dragGhost
        ? createPortal(
            <div
              style={{ left: dragGhost.x, top: dragGhost.y, width: dragGhost.width }}
              className="pointer-events-none fixed z-[60] rotate-1 rounded-2xl border border-[var(--accent)]/50 bg-panel px-4 py-3 opacity-95 shadow-2xl"
            >
              <div className="truncate text-sm font-semibold text-ink">{dragGhost.title}</div>
              <div className="mt-0.5 text-xs text-muted">Drop onto a card to merge</div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

// Drop-target affordance drawn as an overlay above the (opaque) card, using an
// inset ring + tint so the card's rounded corners never clip or break.
const DropHighlight = () => (
  <div className="pointer-events-none absolute inset-0 z-20 rounded-[16px] bg-[var(--accent)]/10 shadow-[inset_0_0_0_2px_var(--accent)]" />
);

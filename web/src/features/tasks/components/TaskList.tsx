'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type TouchEvent as ReactTouchEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { TaskType } from '@/lib/tasks/task-config';
import { orderTasksWithPinnedFirst, useTasksStore } from '../store';
import { useProjectsStore } from '@/features/projects';
import { filterTasksByProject, getStableTaskBackend, resolveTaskDaemonHost } from '../utils/task-filter';
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
  createTaskCardGroup,
  ejectTaskFromGroup,
  loadTaskCardGroups,
  maxTaskCardGroupIdCounter,
  projectTaskCardGroups,
  saveTaskCardGroups,
  setActiveTaskCardTab,
  setTaskCardTabLabel,
  taskCardTabLabel,
  type TaskCardGroup,
} from '../utils/task-card-groups';

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
  const { tasks, isLoading, unreadTaskIds, currentProjectFilter, deleteTask } = useTasksStore();
  const projects = useProjectsStore((state) => state.projects);
  const hiddenProjectIds = useProjectsStore((state) => state.hiddenProjectIds);
  const { confirm } = useConfirm();
  const { pushToast } = useToast();
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [isDeletingSelected, setIsDeletingSelected] = useState(false);
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
  const groupsStorageKey = useMemo(
    () => buildTaskCardGroupsStorageKey(graphStateKey),
    [graphStateKey],
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
  const groupIdSet = useMemo(() => new Set(renderGroups.map((group) => group.id)), [renderGroups]);
  const taskCardRows = useMemo(
    () => buildTaskCardRows(visibleTasks, renderGroups),
    [visibleTasks, renderGroups],
  );
  const selectedTaskIdSet = useMemo(() => new Set(
    [...selectedTaskIds].filter((taskId) => visibleTaskIdSet.has(taskId)),
  ), [selectedTaskIds, visibleTaskIdSet]);
  const selectedCount = selectedTaskIdSet.size;
  const selectionMode = selectedCount > 0;
  const hasToolbarContent = viewMode === 'list' && selectionMode;
  const allSelected = allTaskIds.length > 0 && selectedCount === allTaskIds.length;

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
    const loaded = loadTaskCardGroups(groupsStorageKey);
    skipGroupSaveRef.current = true;
    groupIdCounterRef.current = maxTaskCardGroupIdCounter(loaded);
    setGroups(loaded);
    setEditingTab(null);
  }, [groupsStorageKey]);

  useEffect(() => {
    if (skipGroupSaveRef.current) {
      skipGroupSaveRef.current = false;
      return;
    }
    saveTaskCardGroups(groupsStorageKey, groups);
  }, [groups, groupsStorageKey]);

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

  const toggleTaskSelection = (taskId: string) => {
    setSelectedTaskIds((prev) => {
      const next = new Set([...prev].filter((id) => visibleTaskIdSet.has(id)));
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
    if (selectedTaskIdSet.size === 0 || isDeletingSelected) {
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

    setIsDeletingSelected(true);
    try {
      await Promise.all([...selectedTaskIdSet].map((taskId) => deleteTask(taskId)));
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

  const nextGroupId = (): string => {
    groupIdCounterRef.current += 1;
    return `tabcard-${groupIdCounterRef.current}`;
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
    const projectEntry = projectMap.get(task.projectId ?? '');
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
              <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-[var(--accent)]">
                {selectedCount} selected
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {selectionMode ? (
              <>
                <button type="button"
                  onClick={toggleSelectAll}
                  className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-[var(--paper)] hover:text-ink"
                >
                  {allSelected ? 'Clear All' : 'Select All'}
                </button>
                <button type="button"
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
            return (
              <div
                key={group.id}
                ref={setRowRef(group.id, false)}
                data-task-tab-card={group.id}
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
                        className={`flex shrink-0 cursor-pointer select-none items-center rounded-t-[10px] border px-3 py-1.5 text-xs transition-colors ${
                          isActiveTab
                            ? 'border-[var(--border-default)] border-b-transparent bg-[var(--surface-panel)] font-semibold text-[var(--accent)]'
                            : 'border-transparent bg-[var(--surface-subtle)] font-medium text-muted hover:bg-[var(--surface-panel)] hover:text-ink'
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

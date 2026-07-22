'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { Task } from '@/shared/types';
import { buildTaskDetailHref } from '../utils/task-navigation';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 76;
const NODE_X_GAP = 120;
const NODE_Y_GAP = 40;
const CANVAS_PADDING = 72;
const MIN_SCALE = 0.35;
const MAX_SCALE = 1.8;
const TAB_BAR_HEIGHT = 30;
const GROUP_WIDTH = NODE_WIDTH;
const GROUP_HEIGHT = NODE_HEIGHT + TAB_BAR_HEIGHT;

interface TaskGraphViewProps {
  tasks: Task[];
  activeTaskId?: string | null;
  onOpenTask?: (taskId: string) => void;
  stateKey?: string | null;
}

type GraphEdgeKind = 'restart' | 'issue' | 'manual';

interface GraphEdge {
  sourceId: string;
  targetId: string;
  kind: GraphEdgeKind;
}

interface GraphNodeLayout {
  task: Task;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GraphLayout {
  nodes: GraphNodeLayout[];
  edges: GraphEdge[];
  width: number;
  height: number;
}

type Viewport = {
  x: number;
  y: number;
  scale: number;
};

type Point = {
  x: number;
  y: number;
};

// A "tab card" formed by merging several task cards on the canvas. The cards
// stack at a single position and are surfaced through a tab bar; `activeIndex`
// points at the tab currently rendered on top, `labels` holds per-tab custom
// titles (missing entries fall back to the ordinal 0/1/2… numbering).
type TaskCardGroup = {
  id: string;
  taskIds: string[];
  activeIndex: number;
  labels: Record<string, string>;
  position: Point;
};

type TaskGraphState = {
  viewport: Viewport;
  nodePositions: Record<string, Point>;
  manualEdges: GraphEdge[];
  groups: TaskCardGroup[];
};

type CanvasDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
};

type NodeDragState = CanvasDragState & {
  taskId: string;
  moved: boolean;
  lastX: number;
  lastY: number;
};

type GroupDragState = CanvasDragState & {
  groupId: string;
  moved: boolean;
  startTaskId: string | null;
};

type Rect = { x: number; y: number; width: number; height: number };

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const rectContainsPoint = (rect: Rect, point: Point): boolean =>
  point.x >= rect.x
  && point.x <= rect.x + rect.width
  && point.y >= rect.y
  && point.y <= rect.y + rect.height;

const emptyGraphState = (): TaskGraphState => ({
  viewport: DEFAULT_VIEWPORT,
  nodePositions: {},
  manualEdges: [],
  groups: [],
});

const DEFAULT_VIEWPORT: Viewport = { x: 32, y: 32, scale: 1 };
const TASK_GRAPH_STATE_STORAGE_PREFIX = 'conductor:task-graph-state:v1:';

const buildTaskGraphStorageKey = (stateKey?: string | null): string =>
  `${TASK_GRAPH_STATE_STORAGE_PREFIX}${encodeURIComponent(stateKey?.trim() || 'default')}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readPoint = (value: unknown): Point | null => {
  if (!isObject(value)) return null;
  const { x, y } = value;
  return typeof x === 'number' && Number.isFinite(x)
    && typeof y === 'number' && Number.isFinite(y)
    ? { x, y }
    : null;
};

const readViewport = (value: unknown): Viewport => {
  if (!isObject(value)) return DEFAULT_VIEWPORT;
  const { x, y, scale } = value;
  if (
    typeof x !== 'number' || !Number.isFinite(x)
    || typeof y !== 'number' || !Number.isFinite(y)
    || typeof scale !== 'number' || !Number.isFinite(scale)
  ) {
    return DEFAULT_VIEWPORT;
  }
  return {
    x,
    y,
    scale: clamp(scale, MIN_SCALE, MAX_SCALE),
  };
};

const readNodePositions = (value: unknown): Record<string, Point> => {
  if (!isObject(value)) return {};
  const positions: Record<string, Point> = {};
  for (const [taskId, pointValue] of Object.entries(value)) {
    const point = readPoint(pointValue);
    if (taskId && point) {
      positions[taskId] = point;
    }
  }
  return positions;
};

const readManualEdges = (value: unknown): GraphEdge[] => {
  if (!Array.isArray(value)) return [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  for (const edgeValue of value) {
    if (!isObject(edgeValue)) continue;
    const { sourceId, targetId, kind } = edgeValue;
    if (
      typeof sourceId !== 'string' || !sourceId
      || typeof targetId !== 'string' || !targetId
      || sourceId === targetId
      || kind !== 'manual'
    ) {
      continue;
    }
    const key = edgeKey(sourceId, targetId, 'manual');
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ sourceId, targetId, kind: 'manual' });
  }
  return edges;
};

const readGroups = (value: unknown): TaskCardGroup[] => {
  if (!Array.isArray(value)) return [];
  const groups: TaskCardGroup[] = [];
  const seenIds = new Set<string>();
  const claimedTaskIds = new Set<string>();
  for (const groupValue of value) {
    if (!isObject(groupValue)) continue;
    const { id, taskIds, activeIndex, labels, position } = groupValue;
    if (typeof id !== 'string' || !id || seenIds.has(id)) continue;
    if (!Array.isArray(taskIds)) continue;

    const ids: string[] = [];
    for (const taskId of taskIds) {
      // A task can live in at most one group; drop duplicates and cross-group
      // collisions so the merge state can never fork a single card into two tabs.
      if (typeof taskId === 'string' && taskId && !claimedTaskIds.has(taskId) && !ids.includes(taskId)) {
        ids.push(taskId);
      }
    }
    if (ids.length < 2) continue;

    const point = readPoint(position) ?? { x: CANVAS_PADDING, y: CANVAS_PADDING };
    const labelMap: Record<string, string> = {};
    if (isObject(labels)) {
      for (const [taskId, labelValue] of Object.entries(labels)) {
        if (ids.includes(taskId) && typeof labelValue === 'string' && labelValue.trim()) {
          labelMap[taskId] = labelValue;
        }
      }
    }
    const resolvedActiveIndex = typeof activeIndex === 'number' && Number.isFinite(activeIndex)
      ? clamp(Math.floor(activeIndex), 0, ids.length - 1)
      : 0;

    ids.forEach((taskId) => claimedTaskIds.add(taskId));
    seenIds.add(id);
    groups.push({ id, taskIds: ids, activeIndex: resolvedActiveIndex, labels: labelMap, position: point });
  }
  return groups;
};

// Highest numeric suffix among existing group ids. Seeding the id counter from
// this (rather than from the group *count*) guarantees a freshly-minted id can
// never collide with a persisted one after create/dissolve churn has left
// high-numbered ids behind while the count is low.
const maxGroupIdCounter = (groups: TaskCardGroup[]): number => {
  let max = 0;
  for (const group of groups) {
    const match = /^group-(\d+)/.exec(group.id);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max;
};

const loadTaskGraphState = (storageKey: string): TaskGraphState => {
  if (typeof window === 'undefined') {
    return emptyGraphState();
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return emptyGraphState();
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isObject(parsed)) {
      return emptyGraphState();
    }
    return {
      viewport: readViewport(parsed.viewport),
      nodePositions: readNodePositions(parsed.nodePositions),
      manualEdges: readManualEdges(parsed.manualEdges),
      groups: readGroups(parsed.groups),
    };
  } catch {
    return emptyGraphState();
  }
};

const saveTaskGraphState = (storageKey: string, state: TaskGraphState) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Graph layout state is a convenience cache; storage failures should not block interaction.
  }
};

const parseTaskTime = (task: Task): number => {
  const updated = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
  if (Number.isFinite(updated)) return updated;
  const created = Date.parse(task.createdAt);
  return Number.isFinite(created) ? created : 0;
};

const readStringMetadata = (task: Task, key: string): string | null => {
  const value = task.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

const edgeKey = (sourceId: string, targetId: string, kind: GraphEdgeKind): string =>
  `${kind}:${sourceId}->${targetId}`;

const addEdge = (
  edges: GraphEdge[],
  seen: Set<string>,
  sourceId: string | null,
  targetId: string | null,
  kind: GraphEdgeKind,
  taskIds: Set<string>,
) => {
  if (!sourceId || !targetId || sourceId === targetId) return;
  if (!taskIds.has(sourceId) || !taskIds.has(targetId)) return;
  const key = edgeKey(sourceId, targetId, kind);
  if (seen.has(key)) return;
  seen.add(key);
  edges.push({ sourceId, targetId, kind });
};

const buildGraphEdges = (tasks: Task[]): GraphEdge[] => {
  const taskIds = new Set(tasks.map((task) => task.id));
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const restartPairSeen = new Set<string>();

  for (const task of tasks) {
    const sourceId = readStringMetadata(task, 'continuedFromTaskId');
    if (sourceId) {
      addEdge(edges, seen, sourceId, task.id, 'restart', taskIds);
      restartPairSeen.add(`${sourceId}->${task.id}`);
    }

    const successorId = readStringMetadata(task, 'successorTaskId');
    if (successorId) {
      addEdge(edges, seen, task.id, successorId, 'restart', taskIds);
      restartPairSeen.add(`${task.id}->${successorId}`);
    }
  }

  const tasksByIssue = new Map<string, Task[]>();
  for (const task of tasks) {
    if (!task.issueId) continue;
    const issueTasks = tasksByIssue.get(task.issueId) ?? [];
    issueTasks.push(task);
    tasksByIssue.set(task.issueId, issueTasks);
  }

  for (const issueTasks of tasksByIssue.values()) {
    if (issueTasks.length < 2) continue;
    const ordered = issueTasks
      .slice()
      .sort((a, b) => parseTaskTime(a) - parseTaskTime(b));
    for (let index = 1; index < ordered.length; index += 1) {
      const sourceId = ordered[index - 1].id;
      const targetId = ordered[index].id;
      if (restartPairSeen.has(`${sourceId}->${targetId}`)) continue;
      addEdge(edges, seen, sourceId, targetId, 'issue', taskIds);
    }
  }

  return edges;
};

const buildGraphLayout = (tasks: Task[]): GraphLayout => {
  const edges = buildGraphEdges(tasks);
  const depthByTaskId = new Map(tasks.map((task) => [task.id, 0]));

  for (let pass = 0; pass < tasks.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      const sourceDepth = depthByTaskId.get(edge.sourceId) ?? 0;
      const targetDepth = depthByTaskId.get(edge.targetId) ?? 0;
      if (targetDepth < sourceDepth + 1) {
        depthByTaskId.set(edge.targetId, sourceDepth + 1);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const rowsByDepth = new Map<number, Task[]>();
  for (const task of tasks) {
    const depth = depthByTaskId.get(task.id) ?? 0;
    const rows = rowsByDepth.get(depth) ?? [];
    rows.push(task);
    rowsByDepth.set(depth, rows);
  }

  for (const rows of rowsByDepth.values()) {
    rows.sort((a, b) => parseTaskTime(b) - parseTaskTime(a));
  }

  const nodes: GraphNodeLayout[] = [];
  let maxDepth = 0;
  let maxRows = 0;
  const depths = Array.from(rowsByDepth.keys()).sort((a, b) => a - b);
  for (const depth of depths) {
    const rows = rowsByDepth.get(depth) ?? [];
    maxDepth = Math.max(maxDepth, depth);
    maxRows = Math.max(maxRows, rows.length);
    rows.forEach((task, row) => {
      nodes.push({
        task,
        x: CANVAS_PADDING + depth * (NODE_WIDTH + NODE_X_GAP),
        y: CANVAS_PADDING + row * (NODE_HEIGHT + NODE_Y_GAP),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  }

  return {
    nodes,
    edges,
    width: Math.max(960, CANVAS_PADDING * 2 + (maxDepth + 1) * NODE_WIDTH + maxDepth * NODE_X_GAP),
    height: Math.max(560, CANVAS_PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * NODE_Y_GAP),
  };
};

const PlusIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
  </svg>
);

const MinusIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14" />
  </svg>
);

const ResetIcon = () => (
  <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v6h6M20 20v-6h-6M20 9A8 8 0 006.6 5.1L4 8m16 8l-2.6 2.9A8 8 0 014 15" />
  </svg>
);

export function TaskGraphView({
  tasks,
  activeTaskId = null,
  onOpenTask,
  stateKey = null,
}: TaskGraphViewProps) {
  const router = useRouter();
  const storageKey = useMemo(() => buildTaskGraphStorageKey(stateKey), [stateKey]);
  const initialGraphStateRef = useRef<TaskGraphState | null>(null);
  if (initialGraphStateRef.current === null) {
    initialGraphStateRef.current = loadTaskGraphState(storageKey);
  }
  const initialGraphState = initialGraphStateRef.current;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const canvasDragRef = useRef<CanvasDragState | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const groupDragRef = useRef<GroupDragState | null>(null);
  const groupIdCounterRef = useRef(maxGroupIdCounter(initialGraphState.groups));
  const skipSaveRef = useRef(false);
  const [viewport, setViewport] = useState<Viewport>(() => initialGraphState.viewport);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [nodePositions, setNodePositions] = useState<Record<string, Point>>(
    () => initialGraphState.nodePositions,
  );
  const [manualEdges, setManualEdges] = useState<GraphEdge[]>(
    () => initialGraphState.manualEdges,
  );
  const [groups, setGroups] = useState<TaskCardGroup[]>(() => initialGraphState.groups);
  const [editingTab, setEditingTab] = useState<{ groupId: string; taskId: string } | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [connectingFromTaskId, setConnectingFromTaskId] = useState<string | null>(null);

  const nextGroupId = (): string => {
    groupIdCounterRef.current += 1;
    return `group-${groupIdCounterRef.current}`;
  };
  const layoutTemplate = useMemo(() => buildGraphLayout(tasks), [tasks]);
  const taskIds = useMemo(() => new Set(tasks.map((task) => task.id)), [tasks]);
  const taskIdsKey = useMemo(() => tasks.map((task) => task.id).join('|'), [tasks]);

  useEffect(() => {
    const storedState = loadTaskGraphState(storageKey);
    skipSaveRef.current = true;
    groupIdCounterRef.current = maxGroupIdCounter(storedState.groups);
    setViewport(storedState.viewport);
    setNodePositions(storedState.nodePositions);
    setManualEdges(storedState.manualEdges);
    setGroups(storedState.groups);
    setEditingTab(null);
    setConnectingFromTaskId(null);
  }, [storageKey]);

  useEffect(() => {
    setNodePositions((current) => {
      let next: Record<string, Point> | null = null;

      for (const node of layoutTemplate.nodes) {
        if (!current[node.task.id]) {
          next ??= { ...current };
          next[node.task.id] = { x: node.x, y: node.y };
        }
      }

      return next ?? current;
    });
  }, [layoutTemplate.nodes]);

  useEffect(() => {
    setConnectingFromTaskId((current) => (current && taskIds.has(current) ? current : null));
  }, [taskIds, taskIdsKey]);

  useEffect(() => {
    if (skipSaveRef.current) {
      skipSaveRef.current = false;
      return;
    }
    saveTaskGraphState(storageKey, {
      viewport,
      nodePositions,
      manualEdges,
      groups,
    });
  }, [groups, manualEdges, nodePositions, storageKey, viewport]);

  const nodes = useMemo(
    () =>
      layoutTemplate.nodes.map((node) => {
        const position = nodePositions[node.task.id];
        return position ? { ...node, x: position.x, y: position.y } : node;
      }),
    [layoutTemplate.nodes, nodePositions],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task] as const)),
    [tasks],
  );
  // Project the stored groups onto the currently-visible tasks. Tabs whose task
  // is filtered out are dropped for rendering (but never mutated in storage, so
  // they reappear when the filter clears — mirroring how manual edges behave).
  // A group needs at least two live tabs to stay a tab card; otherwise the lone
  // survivor falls back to a normal node.
  const renderGroups = useMemo(
    () =>
      groups.flatMap((group) => {
        const liveTaskIds = group.taskIds.filter((taskId) => taskById.has(taskId));
        if (liveTaskIds.length < 2) return [];
        const storedActiveId = group.taskIds[group.activeIndex];
        const activeTaskId = storedActiveId && liveTaskIds.includes(storedActiveId)
          ? storedActiveId
          : liveTaskIds[0];
        // Default tab numbers key off each tab's original position, so a tab's
        // ordinal stays fixed even when a sibling tab is filtered out and the
        // rendered list shrinks.
        const ordinals: Record<string, number> = {};
        group.taskIds.forEach((taskId, index) => {
          ordinals[taskId] = index;
        });
        return [{ ...group, taskIds: liveTaskIds, activeTaskId, ordinals }];
      }),
    [groups, taskById],
  );
  const groupedTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of renderGroups) {
      for (const taskId of group.taskIds) ids.add(taskId);
    }
    return ids;
  }, [renderGroups]);
  const individualNodes = useMemo(
    () => nodes.filter((node) => !groupedTaskIds.has(node.task.id)),
    [nodes, groupedTaskIds],
  );
  const canvasSize = useMemo(() => {
    let width = layoutTemplate.width;
    let height = layoutTemplate.height;
    for (const node of individualNodes) {
      width = Math.max(width, node.x + node.width + CANVAS_PADDING);
      height = Math.max(height, node.y + node.height + CANVAS_PADDING);
    }
    for (const group of renderGroups) {
      width = Math.max(width, group.position.x + GROUP_WIDTH + CANVAS_PADDING);
      height = Math.max(height, group.position.y + GROUP_HEIGHT + CANVAS_PADDING);
    }
    return { width, height };
  }, [layoutTemplate.width, layoutTemplate.height, individualNodes, renderGroups]);
  const edges = useMemo(
    () => [...layoutTemplate.edges, ...manualEdges],
    [layoutTemplate.edges, manualEdges],
  );
  // Edge endpoints resolve to either a free node or the tab card that now hosts
  // the task, so relationships stay drawn after cards are merged into a stack.
  const endpointById = useMemo(() => {
    const map = new Map<string, Rect>();
    for (const node of individualNodes) {
      map.set(node.task.id, { x: node.x, y: node.y, width: node.width, height: node.height });
    }
    for (const group of renderGroups) {
      const rect: Rect = {
        x: group.position.x,
        y: group.position.y,
        width: GROUP_WIDTH,
        height: GROUP_HEIGHT,
      };
      for (const taskId of group.taskIds) map.set(taskId, rect);
    }
    return map;
  }, [individualNodes, renderGroups]);

  // Drop an in-progress tab rename once its tab stops being an editable rendered
  // tab — because the group dissolved (e.g. another tab was ejected) or its task
  // was filtered out — so the edit box can never linger or reappear detached.
  useEffect(() => {
    setEditingTab((current) => {
      if (!current) return current;
      const group = renderGroups.find((candidate) => candidate.id === current.groupId);
      return group && group.taskIds.includes(current.taskId) ? current : null;
    });
  }, [renderGroups]);

  const openTask = (taskId: string) => {
    if (onOpenTask) {
      onOpenTask(taskId);
      return;
    }
    router.push(buildTaskDetailHref(taskId));
  };

  const updateScale = (
    current: Viewport,
    nextScale: number,
    anchor?: { x: number; y: number },
  ): Viewport => {
    const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
    const rect = viewportRef.current?.getBoundingClientRect();
    const anchorX = anchor?.x ?? (rect ? rect.width / 2 : 0);
    const anchorY = anchor?.y ?? (rect ? rect.height / 2 : 0);
    const worldX = (anchorX - current.x) / current.scale;
    const worldY = (anchorY - current.y) / current.scale;
    return {
      scale,
      x: anchorX - worldX * scale,
      y: anchorY - worldY * scale,
    };
  };

  const zoomBy = (factor: number, anchor?: { x: number; y: number }) => {
    setViewport((current) => {
      return updateScale(current, current.scale * factor, anchor);
    });
  };

  const resetViewport = () => {
    setViewport(DEFAULT_VIEWPORT);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    zoomBy(delta, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest('[data-task-graph-node="true"], [data-task-graph-control="true"]')
    ) {
      return;
    }
    canvasDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: viewport.x,
      originY: viewport.y,
    };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setIsPanning(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = canvasDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setViewport((current) => ({
      ...current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = canvasDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    canvasDragRef.current = null;
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsPanning(false);
  };

  const addManualEdge = (sourceId: string, targetId: string) => {
    if (sourceId === targetId) return;
    if (!taskIds.has(sourceId) || !taskIds.has(targetId)) return;

    setManualEdges((current) => {
      const alreadyVisible = [...layoutTemplate.edges, ...current].some(
        (edge) => edge.sourceId === sourceId && edge.targetId === targetId,
      );
      if (alreadyVisible) return current;
      return [...current, { sourceId, targetId, kind: 'manual' }];
    });
  };

  const handleNodeActivate = (taskId: string) => {
    if (connectingFromTaskId) {
      if (connectingFromTaskId !== taskId) {
        addManualEdge(connectingFromTaskId, taskId);
      }
      setConnectingFromTaskId(null);
      return;
    }

    openTask(taskId);
  };

  const handleConnectorClick = (taskId: string) => {
    setConnectingFromTaskId((current) => (current === taskId ? null : taskId));
  };

  const addTaskToGroup = (groupId: string, taskId: string) => {
    setGroups((current) =>
      current.map((group) => {
        if (group.id !== groupId || group.taskIds.includes(taskId)) return group;
        const taskIds = [...group.taskIds, taskId];
        // The freshly dropped tab becomes the one shown on top.
        return { ...group, taskIds, activeIndex: taskIds.length - 1 };
      }),
    );
  };

  const createGroupFromTasks = (targetTaskId: string, draggedTaskId: string, position: Point) => {
    setGroups((current) => [
      ...current,
      {
        id: nextGroupId(),
        taskIds: [targetTaskId, draggedTaskId],
        activeIndex: 1,
        labels: {},
        position,
      },
    ]);
  };

  // Called when an individual card is released; if its centre lands over another
  // card it forms a new tab card, and if it lands over an existing tab card it is
  // appended as a new tab. Returns whether a merge happened.
  const mergeDraggedTask = (draggedTaskId: string, center: Point): boolean => {
    for (const group of renderGroups) {
      if (group.taskIds.includes(draggedTaskId)) continue;
      const rect: Rect = {
        x: group.position.x,
        y: group.position.y,
        width: GROUP_WIDTH,
        height: GROUP_HEIGHT,
      };
      if (rectContainsPoint(rect, center)) {
        addTaskToGroup(group.id, draggedTaskId);
        return true;
      }
    }
    for (const node of individualNodes) {
      if (node.task.id === draggedTaskId) continue;
      const rect: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
      if (rectContainsPoint(rect, center)) {
        createGroupFromTasks(node.task.id, draggedTaskId, { x: node.x, y: node.y });
        return true;
      }
    }
    return false;
  };

  const selectGroupTab = (groupId: string, taskId: string) => {
    setGroups((current) =>
      current.map((group) => {
        if (group.id !== groupId) return group;
        const index = group.taskIds.indexOf(taskId);
        if (index < 0 || index === group.activeIndex) return group;
        return { ...group, activeIndex: index };
      }),
    );
  };

  const beginTabEdit = (groupId: string, taskId: string, currentLabel: string) => {
    setEditingTab({ groupId, taskId });
    setEditingValue(currentLabel);
  };

  const commitTabEdit = () => {
    if (!editingTab) return;
    const { groupId, taskId } = editingTab;
    const trimmed = editingValue.trim();
    setGroups((current) =>
      current.map((group) => {
        if (group.id !== groupId) return group;
        const labels = { ...group.labels };
        // An empty title clears the override so the tab returns to its ordinal.
        if (trimmed) {
          labels[taskId] = trimmed;
        } else {
          delete labels[taskId];
        }
        return { ...group, labels };
      }),
    );
    setEditingTab(null);
    setEditingValue('');
  };

  const cancelTabEdit = () => {
    setEditingTab(null);
    setEditingValue('');
  };

  // Pull a tab back out onto the canvas as a standalone card. When only one tab
  // would remain, the tab card dissolves entirely and both cards become nodes.
  const ejectTaskFromGroup = (groupId: string, taskId: string) => {
    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) return;
    const remaining = group.taskIds.filter((id) => id !== taskId);
    setNodePositions((current) => {
      const next = { ...current };
      next[taskId] = { x: group.position.x + 28, y: group.position.y + GROUP_HEIGHT + 16 };
      if (remaining.length < 2 && remaining[0]) {
        next[remaining[0]] = { x: group.position.x, y: group.position.y };
      }
      return next;
    });
    setGroups((current) =>
      current.flatMap((candidate) => {
        if (candidate.id !== groupId) return [candidate];
        if (remaining.length < 2) return [];
        const previousActiveId = candidate.taskIds[candidate.activeIndex];
        const activeIndex = previousActiveId === taskId
          ? 0
          : Math.max(0, remaining.indexOf(previousActiveId));
        const labels = { ...candidate.labels };
        delete labels[taskId];
        return [{ ...candidate, taskIds: remaining, activeIndex, labels }];
      }),
    );
    setEditingTab((current) => (current && current.taskId === taskId ? null : current));
  };

  const handleGroupPointerDown = (
    event: PointerEvent<HTMLDivElement>,
    group: { id: string; position: Point },
  ) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (
      target instanceof Element
      && target.closest('[data-group-no-drag="true"], [data-task-graph-connector="true"]')
    ) {
      return;
    }
    event.stopPropagation();
    const startTab = target instanceof Element ? target.closest('[data-group-tab="true"]') : null;
    groupDragRef.current = {
      groupId: group.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: group.position.x,
      originY: group.position.y,
      moved: false,
      // The pointer id is recaptured onto the container, so remember which tab
      // the gesture began on to distinguish a tab tap from a card drag.
      startTaskId: startTab?.getAttribute('data-task-id') ?? null,
    };
    setDraggingGroupId(group.id);
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handleGroupPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = groupDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    const clientDeltaX = event.clientX - drag.startX;
    const clientDeltaY = event.clientY - drag.startY;
    if (Math.abs(clientDeltaX) > 3 || Math.abs(clientDeltaY) > 3) {
      drag.moved = true;
    }
    const nextPosition = {
      x: drag.originX + clientDeltaX / viewport.scale,
      y: drag.originY + clientDeltaY / viewport.scale,
    };
    setGroups((current) =>
      current.map((group) => (group.id === drag.groupId ? { ...group, position: nextPosition } : group)),
    );
  };

  const endGroupDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = groupDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    groupDragRef.current = null;
    setDraggingGroupId(null);
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      // Dragging the tab card supersedes a pending connect gesture.
      setConnectingFromTaskId(null);
      return;
    }
    if (drag.startTaskId) {
      selectGroupTab(drag.groupId, drag.startTaskId);
      return;
    }
    const group = renderGroups.find((candidate) => candidate.id === drag.groupId);
    if (group) {
      handleNodeActivate(group.activeTaskId);
    }
  };

  const handleNodePointerDown = (
    event: PointerEvent<HTMLDivElement>,
    node: GraphNodeLayout,
  ) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest('[data-task-graph-connector="true"]')) return;

    event.stopPropagation();
    nodeDragRef.current = {
      taskId: node.task.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.x,
      originY: node.y,
      moved: false,
      lastX: node.x,
      lastY: node.y,
    };
    if (typeof event.currentTarget.setPointerCapture === 'function') {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDraggingTaskId(node.task.id);
  };

  const handleNodePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    const clientDeltaX = event.clientX - drag.startX;
    const clientDeltaY = event.clientY - drag.startY;
    if (Math.abs(clientDeltaX) > 3 || Math.abs(clientDeltaY) > 3) {
      drag.moved = true;
    }
    const nextPosition = {
      x: drag.originX + clientDeltaX / viewport.scale,
      y: drag.originY + clientDeltaY / viewport.scale,
    };
    drag.lastX = nextPosition.x;
    drag.lastY = nextPosition.y;
    setNodePositions((current) => ({
      ...current,
      [drag.taskId]: nextPosition,
    }));
  };

  const endNodeDrag = (event: PointerEvent<HTMLDivElement>) => {
    const drag = nodeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    nodeDragRef.current = null;
    setDraggingTaskId(null);
    if (typeof event.currentTarget.releasePointerCapture === 'function') {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (drag.moved) {
      // A drag supersedes any pending "connect from" gesture, so clear it to
      // avoid leaving a source node highlighted after the merge/move.
      setConnectingFromTaskId(null);
      // Merge only when the card's centre is released over another card/tab card.
      const center = { x: drag.lastX + NODE_WIDTH / 2, y: drag.lastY + NODE_HEIGHT / 2 };
      mergeDraggedTask(drag.taskId, center);
      return;
    }
    handleNodeActivate(drag.taskId);
  };

  return (
    <div
      ref={viewportRef}
      data-testid="task-graph-view"
      className={`relative h-full min-h-[420px] overflow-hidden rounded-lg bg-[radial-gradient(circle_at_1px_1px,var(--border)_1px,transparent_0)] bg-[length:28px_28px] ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-task-graph-control="true"
        className="absolute right-3 top-3 z-20 flex items-center gap-1 rounded-lg border border-border bg-panel/95 p-1 shadow-sm"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Zoom out task graph"
          title="Zoom out"
          onClick={() => zoomBy(0.85)}
          className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--surface-subtle)] hover:text-ink"
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          aria-label="Reset task graph view"
          title="Reset view"
          onClick={resetViewport}
          className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--surface-subtle)] hover:text-ink"
        >
          <ResetIcon />
        </button>
        <button
          type="button"
          aria-label="Zoom in task graph"
          title="Zoom in"
          onClick={() => zoomBy(1.15)}
          className="flex size-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-[var(--surface-subtle)] hover:text-ink"
        >
          <PlusIcon />
        </button>
      </div>

      <div
        data-testid="task-graph-stage"
        className="absolute left-0 top-0"
        style={{
          width: canvasSize.width,
          height: canvasSize.height,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
          transformOrigin: '0 0',
        }}
      >
        <svg
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={canvasSize.width}
          height={canvasSize.height}
          aria-hidden="true"
        >
          <defs>
            <marker id="task-graph-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0L8 4L0 8Z" className="fill-[var(--accent)] opacity-70" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const source = endpointById.get(edge.sourceId);
            const target = endpointById.get(edge.targetId);
            if (!source || !target) return null;
            if (source === target) return null;
            const x1 = source.x + source.width;
            const y1 = source.y + source.height / 2;
            const x2 = target.x;
            const y2 = target.y + target.height / 2;
            const curve = Math.max(72, Math.abs(x2 - x1) / 2);
            const path = `M${x1} ${y1} C${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
            return (
              <path
                key={edgeKey(edge.sourceId, edge.targetId, edge.kind)}
                data-testid={`task-graph-edge-${edge.kind}-${edge.sourceId}-${edge.targetId}`}
                d={path}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={edge.kind === 'restart' || edge.kind === 'manual' ? 2.2 : 1.5}
                strokeOpacity={edge.kind === 'restart' ? 0.55 : edge.kind === 'manual' ? 0.62 : 0.32}
                strokeDasharray={edge.kind === 'issue' ? '6 7' : undefined}
                markerEnd="url(#task-graph-arrow)"
              />
            );
          })}
        </svg>

        {individualNodes.map((node) => {
          const task = node.task;
          const isActive = activeTaskId === task.id;
          const isConnectingSource = connectingFromTaskId === task.id;
          const isDragging = draggingTaskId === task.id;

          return (
            <div
              key={task.id}
              role="button"
              tabIndex={0}
              data-task-graph-node="true"
              data-task-graph-node-id={task.id}
              data-testid={`task-graph-node-${task.id}`}
              onPointerDown={(event) => handleNodePointerDown(event, node)}
              onPointerMove={handleNodePointerMove}
              onPointerUp={endNodeDrag}
              onPointerCancel={endNodeDrag}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  handleNodeActivate(task.id);
                }
              }}
              className={`absolute flex items-center rounded-lg border bg-panel px-3 py-2 text-left shadow-sm transition-[border-color,box-shadow] hover:border-[var(--accent)]/60 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/45 ${
                isDragging ? 'cursor-grabbing' : 'cursor-grab'
              } ${
                isActive || isConnectingSource
                  ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(228,87,46,0.12)]'
                  : 'border-border'
              }`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
              }}
              aria-label={`Open task ${task.title}`}
              title={task.title}
            >
              <div className="line-clamp-2 pr-5 text-sm font-semibold leading-5 text-ink">
                {task.title}
              </div>
              <button
                type="button"
                data-task-graph-connector="true"
                aria-label={`Start connection from ${task.title}`}
                title="Create connection"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  handleConnectorClick(task.id);
                }}
                className={`absolute -right-2 top-1/2 size-4 -translate-y-1/2 rounded-full border-2 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/45 ${
                  isConnectingSource
                    ? 'border-[var(--accent)] bg-[var(--accent)]'
                    : 'border-panel bg-[var(--accent)]/70 hover:bg-[var(--accent)]'
                }`}
              />
            </div>
          );
        })}

        {renderGroups.map((group) => {
          const activeTask = taskById.get(group.activeTaskId);
          if (!activeTask) return null;
          const isActive = activeTaskId === group.activeTaskId;
          const isConnectingSource = connectingFromTaskId === group.activeTaskId;
          const isDragging = draggingGroupId === group.id;

          return (
            <div
              key={group.id}
              data-task-graph-node="true"
              data-task-graph-group="true"
              data-task-graph-group-id={group.id}
              data-testid={`task-graph-group-${group.id}`}
              onPointerDown={(event) => handleGroupPointerDown(event, group)}
              onPointerMove={handleGroupPointerMove}
              onPointerUp={endGroupDrag}
              onPointerCancel={endGroupDrag}
              className={`absolute flex flex-col overflow-hidden rounded-lg border bg-panel text-left shadow-sm transition-[border-color,box-shadow] hover:shadow-md ${
                isDragging ? 'cursor-grabbing' : 'cursor-grab'
              } ${
                isActive || isConnectingSource
                  ? 'border-[var(--accent)] shadow-[0_0_0_3px_rgba(228,87,46,0.12)]'
                  : 'border-border'
              }`}
              style={{
                left: group.position.x,
                top: group.position.y,
                width: GROUP_WIDTH,
                height: GROUP_HEIGHT,
              }}
            >
              <div
                className="flex items-stretch gap-0.5 overflow-x-auto border-b border-border bg-[var(--surface-subtle)] px-1 webapp-scrollbar"
                style={{ height: TAB_BAR_HEIGHT }}
              >
                {group.taskIds.map((taskId, index) => {
                  const tabTask = taskById.get(taskId);
                  if (!tabTask) return null;
                  const isActiveTab = taskId === group.activeTaskId;
                  const label = group.labels[taskId] ?? String(group.ordinals[taskId] ?? index);
                  const isEditing = editingTab?.groupId === group.id && editingTab.taskId === taskId;

                  return (
                    <div
                      key={taskId}
                      data-group-tab="true"
                      data-task-id={taskId}
                      data-testid={`task-graph-group-tab-${group.id}-${taskId}`}
                      title={tabTask.title}
                      onDoubleClick={(event) => {
                        event.stopPropagation();
                        beginTabEdit(group.id, taskId, label);
                      }}
                      className={`group/tab relative flex shrink-0 items-center gap-1 rounded-t-md px-2 text-xs font-medium transition-colors ${
                        isActiveTab
                          ? 'bg-panel text-ink shadow-[inset_0_-2px_0_var(--accent)]'
                          : 'text-muted hover:bg-panel/70 hover:text-ink'
                      }`}
                    >
                      {isEditing ? (
                        <input
                          data-group-no-drag="true"
                          data-testid={`task-graph-group-tab-input-${group.id}-${taskId}`}
                          autoFocus
                          value={editingValue}
                          onChange={(event) => setEditingValue(event.target.value)}
                          onPointerDown={(event) => event.stopPropagation()}
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
                          className="w-14 rounded border border-[var(--accent)]/60 bg-panel px-1 text-xs text-ink focus:outline-none"
                        />
                      ) : (
                        <>
                          <span className="max-w-[6rem] truncate">{label}</span>
                          <button
                            type="button"
                            data-group-no-drag="true"
                            aria-label={`Remove ${tabTask.title} from tab card`}
                            title="Remove from tab card"
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation();
                              ejectTaskFromGroup(group.id, taskId);
                            }}
                            className="flex size-3.5 items-center justify-center rounded-full text-muted opacity-0 transition-opacity hover:bg-[var(--accent)]/15 hover:text-ink group-hover/tab:opacity-100"
                          >
                            <svg className="size-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 6l12 12M6 18L18 6" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="relative flex flex-1 items-center px-3 py-2">
                <div className="line-clamp-2 pr-5 text-sm font-semibold leading-5 text-ink">
                  {activeTask.title}
                </div>
                <button
                  type="button"
                  data-task-graph-connector="true"
                  aria-label={`Start connection from ${activeTask.title}`}
                  title="Create connection"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleConnectorClick(group.activeTaskId);
                  }}
                  className={`absolute -right-2 top-1/2 size-4 -translate-y-1/2 rounded-full border-2 shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/45 ${
                    isConnectingSource
                      ? 'border-[var(--accent)] bg-[var(--accent)]'
                      : 'border-panel bg-[var(--accent)]/70 hover:bg-[var(--accent)]'
                  }`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

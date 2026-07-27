// Tab-card grouping for the task *list* view.
//
// Dragging one task card onto another merges them into a single "tab card": the
// cards stack behind a tab bar and only the active tab's card is shown. This
// module holds the pure, framework-free core — the persisted shape, validation,
// localStorage IO, the projection onto currently-visible tasks, list-row
// assembly, and the immutable mutators — so the React layer in TaskList stays
// thin and the behaviour is unit-testable without a DOM.

export type TaskCardGroup = {
  id: string;
  /** Ordered tab membership; index 0 is the first tab. Always length >= 2 when persisted. */
  taskIds: string[];
  /** Index into `taskIds` of the tab shown on top. */
  activeIndex: number;
  /** Per-tab custom titles keyed by taskId; missing entries fall back to the ordinal. */
  labels: Record<string, string>;
};

/** The cross-device shape deliberately excludes activeIndex: opening a tab is device-local UI state. */
export type SyncedTaskCardGroup = Omit<TaskCardGroup, 'activeIndex'>;

export type TaskCardGroupsSyncSnapshot = {
  version: 1;
  revision: number;
  scopes: Record<string, SyncedTaskCardGroup[]>;
};

/** A group projected onto the currently-visible tasks, ready to render. */
export type RenderTaskCardGroup = {
  id: string;
  taskIds: string[];
  labels: Record<string, string>;
  activeTaskId: string;
  /** Original (pre-filter) position of each tab, so default numbering stays stable. */
  ordinals: Record<string, number>;
};

export type TaskCardRow<T> =
  | { type: 'task'; task: T }
  | { type: 'group'; group: RenderTaskCardGroup };

const STORAGE_PREFIX = 'conductor:task-list-groups:v1:';
const USER_STORAGE_PREFIX = 'conductor:task-list-groups:v2:';

/**
 * List tab-cards are a single global set, independent of the active project
 * filter. Persisting/loading them under one fixed scope (rather than one scope
 * per selected project) means a card merged inside a specific project stays
 * visible in the "all tasks" view, and vice versa. `projects:all` is reused so
 * existing "all view" data — and the server scope validation — keep working.
 */
export const LIST_CARD_GROUPS_SCOPE = 'projects:all';
export const MAX_SYNCED_TASK_CARD_SCOPES = 100;
export const MAX_SYNCED_TASK_CARD_GROUPS_PER_SCOPE = 200;
export const MAX_SYNCED_TASKS_PER_CARD = 50;
export const MAX_SYNCED_TASK_CARD_LABEL_LENGTH = 120;

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const buildTaskCardGroupsStorageKey = (
  stateKey?: string | null,
  userId?: string | null,
): string => {
  const encodedState = encodeURIComponent(stateKey?.trim() || 'default');
  const normalizedUserId = userId?.trim();
  return normalizedUserId
    ? `${USER_STORAGE_PREFIX}${encodeURIComponent(normalizedUserId)}:${encodedState}`
    : `${STORAGE_PREFIX}${encodedState}`;
};

/** Validate persisted JSON into groups, enforcing single-group membership per task. */
export const readTaskCardGroups = (value: unknown): TaskCardGroup[] => {
  if (!Array.isArray(value)) return [];
  const groups: TaskCardGroup[] = [];
  const seenIds = new Set<string>();
  const claimedTaskIds = new Set<string>();

  for (const groupValue of value) {
    if (!isObject(groupValue)) continue;
    const { id, taskIds, activeIndex, labels } = groupValue;
    if (typeof id !== 'string' || !id || seenIds.has(id)) continue;
    if (!Array.isArray(taskIds)) continue;

    const ids: string[] = [];
    for (const taskId of taskIds) {
      // A task can live in at most one group; drop duplicates and cross-group
      // collisions so the state can never fork a single card into two tabs.
      if (typeof taskId === 'string' && taskId && !claimedTaskIds.has(taskId) && !ids.includes(taskId)) {
        ids.push(taskId);
      }
    }
    if (ids.length < 2) continue;

    const labelMap: Record<string, string> = {};
    if (isObject(labels)) {
      for (const [taskId, labelValue] of Object.entries(labels)) {
        if (ids.includes(taskId) && typeof labelValue === 'string' && labelValue.trim()) {
          labelMap[taskId] = labelValue;
        }
      }
    }
    const resolvedActiveIndex = typeof activeIndex === 'number' && Number.isFinite(activeIndex)
      ? clampInt(activeIndex, 0, ids.length - 1)
      : 0;

    ids.forEach((taskId) => claimedTaskIds.add(taskId));
    seenIds.add(id);
    groups.push({ id, taskIds: ids, activeIndex: resolvedActiveIndex, labels: labelMap });
  }
  return groups;
};

/** Normalize untrusted API/storage input into the bounded server-synced shape. */
export const readSyncedTaskCardGroups = (value: unknown): SyncedTaskCardGroup[] =>
  readTaskCardGroups(value)
    .filter((group) => group.id.length <= 200)
    .slice(0, MAX_SYNCED_TASK_CARD_GROUPS_PER_SCOPE)
    .flatMap((group) => {
      const taskIds = group.taskIds.slice(0, MAX_SYNCED_TASKS_PER_CARD);
      if (taskIds.length < 2) return [];
      const labels: Record<string, string> = {};
      for (const taskId of taskIds) {
        const label = group.labels[taskId]?.trim();
        if (label) labels[taskId] = label.slice(0, MAX_SYNCED_TASK_CARD_LABEL_LENGTH);
      }
      return [{ id: group.id, taskIds, labels }];
    });

export const toSyncedTaskCardGroups = (groups: TaskCardGroup[]): SyncedTaskCardGroup[] =>
  readSyncedTaskCardGroups(groups);

/**
 * Fold groups from several scopes into one global set. Historically each
 * project filter kept its own scope, so a card merged under a specific project
 * was invisible in the "all tasks" view; folding every scope surfaces them all.
 *
 * A task belongs to exactly one project, so per-scope groups are normally
 * disjoint — only group ids can clash across scopes, so collisions are re-ided
 * rather than dropped (which would silently lose a whole card). Any task that
 * still appears twice (e.g. a stale overlapping scope) is claimed by the first
 * group that lists it, preserving the single-group-per-task invariant. Pass the
 * authoritative scope first so, on collision, its ids win and the union stays
 * stable across reloads.
 */
export const consolidateSyncedTaskCardGroups = (
  scopeGroupLists: SyncedTaskCardGroup[][],
): SyncedTaskCardGroup[] => {
  const seenIds = new Set<string>();
  const claimedTaskIds = new Set<string>();
  const consolidated: SyncedTaskCardGroup[] = [];
  let idCounter = 0;

  for (const list of scopeGroupLists) {
    for (const group of readSyncedTaskCardGroups(list)) {
      const taskIds = group.taskIds.filter((taskId) => !claimedTaskIds.has(taskId));
      if (taskIds.length < 2) continue;

      let id = group.id;
      while (seenIds.has(id)) {
        idCounter += 1;
        id = `tabcard-merged-${idCounter}`;
      }
      seenIds.add(id);
      taskIds.forEach((taskId) => claimedTaskIds.add(taskId));

      const labels: Record<string, string> = {};
      for (const taskId of taskIds) {
        if (group.labels[taskId]) labels[taskId] = group.labels[taskId];
      }
      consolidated.push({ id, taskIds, labels });
      if (consolidated.length >= MAX_SYNCED_TASK_CARD_GROUPS_PER_SCOPE) return consolidated;
    }
  }
  return consolidated;
};

export const taskCardGroupsSyncKey = (groups: TaskCardGroup[] | SyncedTaskCardGroup[]): string =>
  JSON.stringify(readSyncedTaskCardGroups(groups));

/**
 * Apply server-owned structure while preserving the active tab from this
 * device whenever that tab still belongs to the synchronized group.
 */
export const mergeSyncedTaskCardGroups = (
  localGroups: TaskCardGroup[],
  syncedGroups: SyncedTaskCardGroup[],
): TaskCardGroup[] => {
  const localById = new Map(localGroups.map((group) => [group.id, group]));
  return readSyncedTaskCardGroups(syncedGroups).map((group) => {
    const local = localById.get(group.id);
    const localActiveTaskId = local?.taskIds[local.activeIndex];
    const activeIndex = localActiveTaskId ? group.taskIds.indexOf(localActiveTaskId) : -1;
    return {
      ...group,
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
    };
  });
};

export const readTaskCardGroupsSyncSnapshot = (value: unknown): TaskCardGroupsSyncSnapshot => {
  const record = isObject(value) ? value : {};
  const rawRevision = record.revision;
  const revision = typeof rawRevision === 'number' && Number.isFinite(rawRevision)
    ? Math.max(0, Math.floor(rawRevision))
    : 0;
  const rawScopes = isObject(record.scopes) ? record.scopes : {};
  const scopes: Record<string, SyncedTaskCardGroup[]> = {};

  for (const [scope, groups] of Object.entries(rawScopes).slice(0, MAX_SYNCED_TASK_CARD_SCOPES)) {
    if (!scope.startsWith('projects:') || scope.length > 512 || !Array.isArray(groups)) continue;
    scopes[scope] = readSyncedTaskCardGroups(groups);
  }

  return { version: 1, revision, scopes };
};

export const loadTaskCardGroups = (storageKey: string): TaskCardGroup[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    return readTaskCardGroups(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
};

export const saveTaskCardGroups = (storageKey: string, groups: TaskCardGroup[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(groups));
  } catch {
    // Grouping is a convenience cache; storage failures must not block interaction.
  }
};

/**
 * Highest numeric suffix among existing group ids. Seeding an id counter from
 * this (rather than the group count) guarantees a freshly-minted id can never
 * collide with a persisted one after create/dissolve churn.
 */
export const maxTaskCardGroupIdCounter = (groups: TaskCardGroup[]): number => {
  let max = 0;
  for (const group of groups) {
    const match = /^tabcard-(\d+)/.exec(group.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
};

/**
 * Project stored groups onto the currently-visible tasks. Tabs whose task is
 * filtered out are dropped for rendering (never mutated in storage, so they
 * reappear when the filter clears); a group needs >= 2 live tabs to remain a
 * tab card, otherwise the lone survivor falls back to a normal row.
 */
export const projectTaskCardGroups = (
  groups: TaskCardGroup[],
  isLiveTaskId: (taskId: string) => boolean,
): RenderTaskCardGroup[] => {
  const rendered: RenderTaskCardGroup[] = [];
  for (const group of groups) {
    const liveTaskIds = group.taskIds.filter(isLiveTaskId);
    if (liveTaskIds.length < 2) continue;
    const storedActiveId = group.taskIds[group.activeIndex];
    const activeTaskId = storedActiveId && liveTaskIds.includes(storedActiveId)
      ? storedActiveId
      : liveTaskIds[0];
    const ordinals: Record<string, number> = {};
    group.taskIds.forEach((taskId, index) => {
      ordinals[taskId] = index;
    });
    rendered.push({ id: group.id, taskIds: liveTaskIds, labels: group.labels, activeTaskId, ordinals });
  }
  return rendered;
};

/**
 * Fold an ordered task list into rows of either a single task or a tab card.
 * A group is emitted once, anchored at the list position of its first member.
 */
export const buildTaskCardRows = <T extends { id: string }>(
  orderedTasks: T[],
  renderGroups: RenderTaskCardGroup[],
): TaskCardRow<T>[] => {
  const groupByTaskId = new Map<string, RenderTaskCardGroup>();
  for (const group of renderGroups) {
    for (const taskId of group.taskIds) groupByTaskId.set(taskId, group);
  }
  const emitted = new Set<string>();
  const rows: TaskCardRow<T>[] = [];
  for (const task of orderedTasks) {
    const group = groupByTaskId.get(task.id);
    if (!group) {
      rows.push({ type: 'task', task });
      continue;
    }
    if (emitted.has(group.id)) continue;
    emitted.add(group.id);
    rows.push({ type: 'group', group });
  }
  return rows;
};

/** Remove a task from every group; drop any group left with fewer than 2 tabs. */
const withoutTask = (groups: TaskCardGroup[], taskId: string): TaskCardGroup[] =>
  groups.flatMap((group) => {
    if (!group.taskIds.includes(taskId)) return [group];
    const taskIds = group.taskIds.filter((id) => id !== taskId);
    if (taskIds.length < 2) return [];
    const previousActiveId = group.taskIds[group.activeIndex];
    const activeIndex = previousActiveId === taskId
      ? 0
      : Math.max(0, taskIds.indexOf(previousActiveId));
    const labels = { ...group.labels };
    delete labels[taskId];
    return [{ ...group, taskIds, activeIndex, labels }];
  });

/** Merge a dragged task onto a lone target task, forming a new 2-tab card. */
export const createTaskCardGroup = (
  groups: TaskCardGroup[],
  newId: string,
  targetTaskId: string,
  draggedTaskId: string,
): TaskCardGroup[] => {
  if (targetTaskId === draggedTaskId) return groups;
  const cleaned = withoutTask(withoutTask(groups, draggedTaskId), targetTaskId);
  return [
    ...cleaned,
    { id: newId, taskIds: [targetTaskId, draggedTaskId], activeIndex: 1, labels: {} },
  ];
};

/** Append a dragged task as a new (active) tab of an existing tab card. */
export const addTaskToGroup = (
  groups: TaskCardGroup[],
  groupId: string,
  draggedTaskId: string,
): TaskCardGroup[] => {
  const detached = withoutTask(groups, draggedTaskId);
  return detached.map((group) => {
    if (group.id !== groupId || group.taskIds.includes(draggedTaskId)) return group;
    const taskIds = [...group.taskIds, draggedTaskId];
    return { ...group, taskIds, activeIndex: taskIds.length - 1 };
  });
};

/** Switch which tab is shown on top. */
export const setActiveTaskCardTab = (
  groups: TaskCardGroup[],
  groupId: string,
  taskId: string,
): TaskCardGroup[] =>
  groups.map((group) => {
    if (group.id !== groupId) return group;
    const index = group.taskIds.indexOf(taskId);
    if (index < 0 || index === group.activeIndex) return group;
    return { ...group, activeIndex: index };
  });

/** Set (or, with an empty value, clear) a tab's custom title. */
export const setTaskCardTabLabel = (
  groups: TaskCardGroup[],
  groupId: string,
  taskId: string,
  label: string,
): TaskCardGroup[] => {
  const trimmed = label.trim();
  return groups.map((group) => {
    if (group.id !== groupId) return group;
    const labels = { ...group.labels };
    if (trimmed) {
      labels[taskId] = trimmed;
    } else {
      delete labels[taskId];
    }
    return { ...group, labels };
  });
};

/** Pull a tab back out; dissolve the whole card when fewer than 2 tabs remain. */
export const ejectTaskFromGroup = (
  groups: TaskCardGroup[],
  groupId: string,
  taskId: string,
): TaskCardGroup[] =>
  groups.flatMap((group) => {
    if (group.id !== groupId) return [group];
    const taskIds = group.taskIds.filter((id) => id !== taskId);
    if (taskIds.length < 2) return [];
    const previousActiveId = group.taskIds[group.activeIndex];
    const activeIndex = previousActiveId === taskId
      ? 0
      : Math.max(0, taskIds.indexOf(previousActiveId));
    const labels = { ...group.labels };
    delete labels[taskId];
    return [{ ...group, taskIds, activeIndex, labels }];
  });

/** Default numeric label for a tab, honouring any custom override. */
export const taskCardTabLabel = (group: RenderTaskCardGroup, taskId: string): string =>
  group.labels[taskId] ?? String(group.ordinals[taskId] ?? 0);

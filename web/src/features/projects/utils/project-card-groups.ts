// Tab-card *aggregation* for the project list view.
//
// Dragging one project card onto (the middle of) another aggregates them into a
// single "tab card": the cards stack behind a tab bar and only the active tab's
// card is shown. Unlike the project *merge* feature — which fuses same-repo
// projects that live on different daemons and is a real cross-daemon grouping —
// aggregation is a purely presentational, frontend-only grouping of otherwise
// unrelated projects. It never touches any project row in the database; the
// membership lives entirely in the user's preferences.
//
// This module holds the pure, framework-free core — the persisted shape,
// validation, localStorage IO, the projection onto currently-visible project
// groups, list-row assembly, and the immutable mutators — so the React layer in
// ProjectList stays thin and the behaviour is unit-testable without a DOM.
//
// A "member" of an aggregation is identified by a *project id*. That id points
// at whichever project-list *card* currently owns it: a card can be a single
// project or a merged (cross-daemon) group, so the id is resolved to its live
// group at render time. Storing an id rather than a derived group key keeps the
// aggregation stable across merges, reorders, and daemon online/offline churn.

export type ProjectCardGroup = {
  id: string;
  /** Ordered tab membership; index 0 is the first tab. Always length >= 2 when persisted. */
  projectIds: string[];
  /** Index into `projectIds` of the tab shown on top. */
  activeIndex: number;
  /** Per-tab custom titles keyed by projectId; missing entries fall back to the card's name. */
  labels: Record<string, string>;
};

/** The cross-device shape deliberately excludes activeIndex: opening a tab is device-local UI state. */
export type SyncedProjectCardGroup = Omit<ProjectCardGroup, 'activeIndex'>;

export type ProjectCardGroupsSyncSnapshot = {
  version: 1;
  revision: number;
  scopes: Record<string, SyncedProjectCardGroup[]>;
};

/** One aggregation tab resolved onto a live project-list card. */
export type ProjectCardTab<G> = {
  /** The stored representative project id for this tab. */
  projectId: string;
  /** The live card (single project or merged group) this tab renders. */
  group: G;
};

export type ProjectAggregationRow<G> = {
  type: 'aggregation';
  id: string;
  /** Distinct live tabs, in stored order; always length >= 2. */
  tabs: ProjectCardTab<G>[];
  /** Representative project id of the tab shown on top. */
  activeProjectId: string;
  /** Custom labels keyed by representative projectId. */
  labels: Record<string, string>;
  /** Original (pre-filter) position of each tab, so default numbering stays stable. */
  ordinals: Record<string, number>;
};

export type ProjectCardRow<G> =
  | { type: 'group'; group: G }
  | ProjectAggregationRow<G>;

const STORAGE_PREFIX = 'conductor:project-list-groups:v1:';

/**
 * Project aggregations are a single global set, independent of any filter.
 * Persisting/loading them under one fixed scope keeps the storage and the
 * server scope validation trivial. The `projects:` prefix is kept so the shared
 * snapshot validation (which requires it) accepts the scope unchanged.
 */
export const PROJECT_CARD_GROUPS_SCOPE = 'projects:all';
export const MAX_SYNCED_PROJECT_CARD_SCOPES = 100;
export const MAX_SYNCED_PROJECT_CARD_GROUPS_PER_SCOPE = 200;
export const MAX_SYNCED_PROJECTS_PER_CARD = 50;
export const MAX_SYNCED_PROJECT_CARD_LABEL_LENGTH = 120;

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.floor(value)));

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const buildProjectCardGroupsStorageKey = (userId?: string | null): string => {
  const normalizedUserId = userId?.trim();
  return normalizedUserId
    ? `${STORAGE_PREFIX}${encodeURIComponent(normalizedUserId)}`
    : `${STORAGE_PREFIX}default`;
};

/** Validate persisted JSON into groups, enforcing single-group membership per project. */
export const readProjectCardGroups = (value: unknown): ProjectCardGroup[] => {
  if (!Array.isArray(value)) return [];
  const groups: ProjectCardGroup[] = [];
  const seenIds = new Set<string>();
  const claimedProjectIds = new Set<string>();

  for (const groupValue of value) {
    if (!isObject(groupValue)) continue;
    const { id, projectIds, activeIndex, labels } = groupValue;
    if (typeof id !== 'string' || !id || seenIds.has(id)) continue;
    if (!Array.isArray(projectIds)) continue;

    const ids: string[] = [];
    for (const projectId of projectIds) {
      // A project can live in at most one aggregation; drop duplicates and
      // cross-group collisions so the state can never fork one card into two tabs.
      if (
        typeof projectId === 'string'
        && projectId
        && !claimedProjectIds.has(projectId)
        && !ids.includes(projectId)
      ) {
        ids.push(projectId);
      }
    }
    if (ids.length < 2) continue;

    const labelMap: Record<string, string> = {};
    if (isObject(labels)) {
      for (const [projectId, labelValue] of Object.entries(labels)) {
        if (ids.includes(projectId) && typeof labelValue === 'string' && labelValue.trim()) {
          labelMap[projectId] = labelValue;
        }
      }
    }
    const resolvedActiveIndex = typeof activeIndex === 'number' && Number.isFinite(activeIndex)
      ? clampInt(activeIndex, 0, ids.length - 1)
      : 0;

    ids.forEach((projectId) => claimedProjectIds.add(projectId));
    seenIds.add(id);
    groups.push({ id, projectIds: ids, activeIndex: resolvedActiveIndex, labels: labelMap });
  }
  return groups;
};

/** Normalize untrusted API/storage input into the bounded server-synced shape. */
export const readSyncedProjectCardGroups = (value: unknown): SyncedProjectCardGroup[] =>
  readProjectCardGroups(value)
    .filter((group) => group.id.length <= 200)
    .slice(0, MAX_SYNCED_PROJECT_CARD_GROUPS_PER_SCOPE)
    .flatMap((group) => {
      const projectIds = group.projectIds.slice(0, MAX_SYNCED_PROJECTS_PER_CARD);
      if (projectIds.length < 2) return [];
      const labels: Record<string, string> = {};
      for (const projectId of projectIds) {
        const label = group.labels[projectId]?.trim();
        if (label) labels[projectId] = label.slice(0, MAX_SYNCED_PROJECT_CARD_LABEL_LENGTH);
      }
      return [{ id: group.id, projectIds, labels }];
    });

export const toSyncedProjectCardGroups = (groups: ProjectCardGroup[]): SyncedProjectCardGroup[] =>
  readSyncedProjectCardGroups(groups);

/**
 * Fold groups from several scopes into one global set. Aggregation only ever
 * uses a single scope, but keeping this parallel to the task implementation
 * lets the storage/route layers stay identical and tolerant of any stray scope.
 * A project belongs to exactly one aggregation, so per-scope groups are normally
 * disjoint — only group ids can clash across scopes, so collisions are re-ided
 * rather than dropped. Pass the authoritative scope first so its ids win.
 */
export const consolidateSyncedProjectCardGroups = (
  scopeGroupLists: SyncedProjectCardGroup[][],
): SyncedProjectCardGroup[] => {
  const seenIds = new Set<string>();
  const claimedProjectIds = new Set<string>();
  const consolidated: SyncedProjectCardGroup[] = [];
  let idCounter = 0;

  for (const list of scopeGroupLists) {
    for (const group of readSyncedProjectCardGroups(list)) {
      const projectIds = group.projectIds.filter((projectId) => !claimedProjectIds.has(projectId));
      if (projectIds.length < 2) continue;

      let id = group.id;
      while (seenIds.has(id)) {
        idCounter += 1;
        id = `projcard-merged-${idCounter}`;
      }
      seenIds.add(id);
      projectIds.forEach((projectId) => claimedProjectIds.add(projectId));

      const labels: Record<string, string> = {};
      for (const projectId of projectIds) {
        if (group.labels[projectId]) labels[projectId] = group.labels[projectId];
      }
      consolidated.push({ id, projectIds, labels });
      if (consolidated.length >= MAX_SYNCED_PROJECT_CARD_GROUPS_PER_SCOPE) return consolidated;
    }
  }
  return consolidated;
};

export const projectCardGroupsSyncKey = (
  groups: ProjectCardGroup[] | SyncedProjectCardGroup[],
): string => JSON.stringify(readSyncedProjectCardGroups(groups));

/**
 * Apply server-owned structure while preserving the active tab from this
 * device whenever that tab still belongs to the synchronized group.
 */
export const mergeSyncedProjectCardGroups = (
  localGroups: ProjectCardGroup[],
  syncedGroups: SyncedProjectCardGroup[],
): ProjectCardGroup[] => {
  const localById = new Map(localGroups.map((group) => [group.id, group]));
  return readSyncedProjectCardGroups(syncedGroups).map((group) => {
    const local = localById.get(group.id);
    const localActiveProjectId = local?.projectIds[local.activeIndex];
    const activeIndex = localActiveProjectId ? group.projectIds.indexOf(localActiveProjectId) : -1;
    return {
      ...group,
      activeIndex: activeIndex >= 0 ? activeIndex : 0,
    };
  });
};

export const readProjectCardGroupsSyncSnapshot = (
  value: unknown,
): ProjectCardGroupsSyncSnapshot => {
  const record = isObject(value) ? value : {};
  const rawRevision = record.revision;
  const revision = typeof rawRevision === 'number' && Number.isFinite(rawRevision)
    ? Math.max(0, Math.floor(rawRevision))
    : 0;
  const rawScopes = isObject(record.scopes) ? record.scopes : {};
  const scopes: Record<string, SyncedProjectCardGroup[]> = {};

  for (const [scope, groups] of Object.entries(rawScopes).slice(0, MAX_SYNCED_PROJECT_CARD_SCOPES)) {
    if (!scope.startsWith('projects:') || scope.length > 512 || !Array.isArray(groups)) continue;
    scopes[scope] = readSyncedProjectCardGroups(groups);
  }

  return { version: 1, revision, scopes };
};

export const loadProjectCardGroups = (storageKey: string): ProjectCardGroup[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    return readProjectCardGroups(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
};

export const saveProjectCardGroups = (storageKey: string, groups: ProjectCardGroup[]): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(groups));
  } catch {
    // Aggregation is a convenience cache; storage failures must not block interaction.
  }
};

/**
 * Highest numeric suffix among existing group ids. Seeding an id counter from
 * this (rather than the group count) guarantees a freshly-minted id can never
 * collide with a persisted one after create/dissolve churn.
 */
export const maxProjectCardGroupIdCounter = (groups: ProjectCardGroup[]): number => {
  let max = 0;
  for (const group of groups) {
    const match = /^projcard-(\d+)/.exec(group.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
};

/**
 * Fold ordered project-list cards into rows of either a single card or an
 * aggregation tab card. Each stored projectId is resolved to its live card via
 * `resolveGroup`; tabs whose project is filtered out (resolver returns null) are
 * dropped for rendering, and multiple ids resolving to the same card are
 * de-duplicated by the card's `key`. An aggregation needs >= 2 live, distinct
 * tabs to remain a tab card, otherwise its survivors fall back to normal rows.
 * A group is emitted once, anchored at the list position of its first member.
 */
export const buildProjectCardRows = <G extends { key: string }>(
  orderedGroups: G[],
  aggregations: ProjectCardGroup[],
  resolveGroup: (projectId: string) => G | null,
): ProjectCardRow<G>[] => {
  const aggRowByCardKey = new Map<string, ProjectAggregationRow<G>>();

  for (const aggregation of aggregations) {
    const tabs: ProjectCardTab<G>[] = [];
    const ordinals: Record<string, number> = {};
    const seenCardKeys = new Set<string>();
    aggregation.projectIds.forEach((projectId, index) => {
      ordinals[projectId] = index;
    });
    for (const projectId of aggregation.projectIds) {
      const group = resolveGroup(projectId);
      if (!group || seenCardKeys.has(group.key)) continue;
      seenCardKeys.add(group.key);
      tabs.push({ projectId, group });
    }
    if (tabs.length < 2) continue;

    const storedActiveProjectId = aggregation.projectIds[aggregation.activeIndex];
    const activeProjectId = storedActiveProjectId
      && tabs.some((tab) => tab.projectId === storedActiveProjectId)
      ? storedActiveProjectId
      : tabs[0].projectId;

    const row: ProjectAggregationRow<G> = {
      type: 'aggregation',
      id: aggregation.id,
      tabs,
      activeProjectId,
      labels: aggregation.labels,
      ordinals,
    };
    for (const tab of tabs) aggRowByCardKey.set(tab.group.key, row);
  }

  const emitted = new Set<string>();
  const rows: ProjectCardRow<G>[] = [];
  for (const group of orderedGroups) {
    const aggRow = aggRowByCardKey.get(group.key);
    if (!aggRow) {
      rows.push({ type: 'group', group });
      continue;
    }
    if (emitted.has(aggRow.id)) continue;
    emitted.add(aggRow.id);
    rows.push(aggRow);
  }
  return rows;
};

/** Remove a project from every aggregation; drop any left with fewer than 2 tabs. */
const withoutProject = (groups: ProjectCardGroup[], projectId: string): ProjectCardGroup[] =>
  groups.flatMap((group) => {
    if (!group.projectIds.includes(projectId)) return [group];
    const projectIds = group.projectIds.filter((id) => id !== projectId);
    if (projectIds.length < 2) return [];
    const previousActiveId = group.projectIds[group.activeIndex];
    const activeIndex = previousActiveId === projectId
      ? 0
      : Math.max(0, projectIds.indexOf(previousActiveId));
    const labels = { ...group.labels };
    delete labels[projectId];
    return [{ ...group, projectIds, activeIndex, labels }];
  });

/** Aggregate a dragged card onto a lone target card, forming a new 2-tab card. */
export const createProjectCardGroup = (
  groups: ProjectCardGroup[],
  newId: string,
  targetProjectId: string,
  draggedProjectId: string,
): ProjectCardGroup[] => {
  if (targetProjectId === draggedProjectId) return groups;
  const cleaned = withoutProject(withoutProject(groups, draggedProjectId), targetProjectId);
  return [
    ...cleaned,
    { id: newId, projectIds: [targetProjectId, draggedProjectId], activeIndex: 1, labels: {} },
  ];
};

/** Append a dragged card as a new (active) tab of an existing aggregation. */
export const addProjectToGroup = (
  groups: ProjectCardGroup[],
  groupId: string,
  draggedProjectId: string,
): ProjectCardGroup[] => {
  const detached = withoutProject(groups, draggedProjectId);
  return detached.map((group) => {
    if (group.id !== groupId || group.projectIds.includes(draggedProjectId)) return group;
    const projectIds = [...group.projectIds, draggedProjectId];
    return { ...group, projectIds, activeIndex: projectIds.length - 1 };
  });
};

/** Switch which tab is shown on top. */
export const setActiveProjectCardTab = (
  groups: ProjectCardGroup[],
  groupId: string,
  projectId: string,
): ProjectCardGroup[] =>
  groups.map((group) => {
    if (group.id !== groupId) return group;
    const index = group.projectIds.indexOf(projectId);
    if (index < 0 || index === group.activeIndex) return group;
    return { ...group, activeIndex: index };
  });

/** Set (or, with an empty value, clear) a tab's custom title. */
export const setProjectCardTabLabel = (
  groups: ProjectCardGroup[],
  groupId: string,
  projectId: string,
  label: string,
): ProjectCardGroup[] => {
  const trimmed = label.trim();
  return groups.map((group) => {
    if (group.id !== groupId) return group;
    const labels = { ...group.labels };
    if (trimmed) {
      labels[projectId] = trimmed;
    } else {
      delete labels[projectId];
    }
    return { ...group, labels };
  });
};

/** Pull a tab back out; dissolve the whole card when fewer than 2 tabs remain. */
export const ejectProjectFromGroup = (
  groups: ProjectCardGroup[],
  groupId: string,
  projectId: string,
): ProjectCardGroup[] =>
  groups.flatMap((group) => {
    if (group.id !== groupId) return [group];
    const projectIds = group.projectIds.filter((id) => id !== projectId);
    if (projectIds.length < 2) return [];
    const previousActiveId = group.projectIds[group.activeIndex];
    const activeIndex = previousActiveId === projectId
      ? 0
      : Math.max(0, projectIds.indexOf(previousActiveId));
    const labels = { ...group.labels };
    delete labels[projectId];
    return [{ ...group, projectIds, activeIndex, labels }];
  });

'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragCancelEvent,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, type SortingStrategy } from '@dnd-kit/sortable';
import type { Project, ProjectGroup } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useAuthStore } from '@/features/auth/store';
import { useProjectsStore } from '../store';
import { ProjectItem } from './ProjectItem';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { getProjectListVisibility } from '../utils/project-list-order';
import { useProjectCardGroupsSyncStore } from '../project-card-groups-sync-store';
import {
  addProjectToGroup,
  buildProjectCardRows,
  createProjectCardGroup,
  ejectProjectFromGroup,
  maxProjectCardGroupIdCounter,
  mergeSyncedProjectCardGroups,
  PROJECT_CARD_GROUPS_SCOPE,
  projectCardGroupsSyncKey,
  readSyncedProjectCardGroups,
  setActiveProjectCardTab,
  setProjectCardTabLabel,
  type ProjectCardGroup,
  type ProjectCardRow,
} from '../utils/project-card-groups';
import type { ProjectCardTab } from './ProjectCardTabBar';

const collisionDetection: CollisionDetection = (args) => {
  const pointerIntersections = pointerWithin(args);
  if (pointerIntersections.length > 0) {
    return pointerIntersections;
  }
  return closestCenter(args);
};

const PROJECT_DRAG_ACTIVATION_DELAY_MS = 350;
const PROJECT_DRAG_ACTIVATION_TOLERANCE_PX = 8;
const PROJECT_DRAG_ACTIVATION_DISTANCE_PX = 6;

// Keep every card in its layout slot while dragging. Reorder transforms move
// the visible target away as soon as the pointer crosses its outer edge, before
// the pointer can reach the center band used for aggregation. The DragOverlay
// still follows the pointer; the committed list order changes on drop.
const stableProjectSortingStrategy: SortingStrategy = () => null;

// A drop counts as "aggregate onto this card" only when the live pointer sits
// inside the middle band of the target card. Landing in the outer thirds (i.e.
// near the gap between two cards) reorders instead. This is the whole
// distinction between aggregating and repositioning: on-card vs in-the-gap.
const AGGREGATE_BAND_MIN = 0.32;
const AGGREGATE_BAND_MAX = 0.68;

type DragPointer = { x: number; y: number };
type DragPointerEvent = Pick<DragMoveEvent, 'activatorEvent' | 'delta'>;
type RowPointerHit = { key: string; rect: DOMRect };

// Recover the live pointer position from dnd-kit's activator event plus the
// accumulated delta. `onDragMove` runs for every pointer movement, unlike
// `onDragOver`, which only runs when the collision target changes.
const readDragPointer = (event: DragPointerEvent): DragPointer | null => {
  const activator = event.activatorEvent as
    | (Partial<MouseEvent> & Partial<Pick<TouchEvent, 'touches' | 'changedTouches'>>)
    | null
    | undefined;
  if (!activator) return null;
  const deltaX = event.delta?.x ?? 0;
  const deltaY = event.delta?.y ?? 0;
  if (typeof activator.clientX === 'number' && typeof activator.clientY === 'number') {
    return {
      x: activator.clientX + deltaX,
      y: activator.clientY + deltaY,
    };
  }
  const touch = activator.touches?.[0] ?? activator.changedTouches?.[0];
  if (touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
    return {
      x: touch.clientX + deltaX,
      y: touch.clientY + deltaY,
    };
  }
  return null;
};

type Row = ProjectCardRow<ProjectGroup>;

const rowKeyOf = (row: Row): string =>
  row.type === 'group' ? row.group.key : `agg:${row.id}`;

const primaryProjectIdOf = (group: ProjectGroup): string => group.members[0].id;

const reorderRowsLocally = (rows: Row[], activeKey: string, overKey: string): Row[] => {
  const activeIndex = rows.findIndex((row) => rowKeyOf(row) === activeKey);
  if (activeIndex === -1) return rows;
  const overIndex = rows.findIndex((row) => rowKeyOf(row) === overKey);
  if (overIndex === -1 || overIndex === activeIndex) return rows;
  const next = [...rows];
  const [moved] = next.splice(activeIndex, 1);
  next.splice(overIndex, 0, moved);
  return next;
};

const flattenRowsToProjectIds = (rows: Row[]): string[] => {
  const out: string[] = [];
  for (const row of rows) {
    if (row.type === 'group') {
      for (const member of row.group.members) out.push(member.id);
    } else {
      for (const tab of row.tabs) {
        for (const member of tab.group.members) out.push(member.id);
      }
    }
  }
  return out;
};

export function ProjectList() {
  const {
    projects,
    isLoading,
    selectedProjectId,
    hiddenProjectIds,
    showHiddenProjects,
    setSelectedProjectId,
    hideProject,
    unhideProject,
    reorderProjects,
  } = useProjectsStore();
  const agents = useAgentsStore((state) => state.agents);
  const userId = useAuthStore((state) => state.session?.user.id ?? null);

  const snapshot = useProjectCardGroupsSyncStore((state) => state.snapshot);
  const aggregationsHydrated = useProjectCardGroupsSyncStore((state) => state.hydrated);
  const hydrateAggregations = useProjectCardGroupsSyncStore((state) => state.hydrate);
  const saveAggregationsScope = useProjectCardGroupsSyncStore((state) => state.saveScope);

  // Device-local aggregation state. The server-synced snapshot owns the
  // structure (membership + labels); `activeIndex` is device-local UI, so it is
  // merged in from here whenever the snapshot changes.
  const [aggregations, setAggregations] = useState<ProjectCardGroup[]>([]);
  const lastSyncedKeyRef = useRef<string>(projectCardGroupsSyncKey([]));

  const onlineDaemonHosts = useMemo(
    () => new Set(agents.flatMap((agent) => {
      const host = agent.host.trim();
      return host ? [host] : [];
    })),
    [agents],
  );
  const projectListVisibility = useMemo(
    () => getProjectListVisibility(projects, {
      hiddenProjectIds,
      showHiddenProjects,
      onlineDaemonHosts,
    }),
    [hiddenProjectIds, onlineDaemonHosts, projects, showHiddenProjects],
  );
  const {
    hiddenProjectIdSet,
    onlineProjects,
    visibleProjects,
    visibleGroups,
  } = projectListVisibility;

  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: PROJECT_DRAG_ACTIVATION_DISTANCE_PX,
      },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: PROJECT_DRAG_ACTIVATION_DELAY_MS,
        tolerance: PROJECT_DRAG_ACTIVATION_TOLERANCE_PX,
      },
    }),
  );

  // Live DOM refs for each rendered row wrapper, keyed by row key. The wrapper is
  // NOT the dnd-kit sortable node (that transformed node lives inside
  // ProjectItem), so its getBoundingClientRect reports the stable layout slot —
  // exactly the target geometry the pointer band test needs, undisturbed by the
  // sortable's transforms.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const setRowRef = useCallback((key: string) => (node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(key, node);
    else rowRefs.current.delete(key);
  }, []);
  const findRowAtPointer = useCallback((
    pointer: DragPointer,
    exceptKey: string,
  ): RowPointerHit | null => {
    let hit: RowPointerHit | null = null;
    rowRefs.current.forEach((node, key) => {
      if (key === exceptKey) return;
      const rect = node.getBoundingClientRect();
      if (
        pointer.x >= rect.left
        && pointer.x <= rect.right
        && pointer.y >= rect.top
        && pointer.y <= rect.bottom
      ) {
        hit = { key, rect };
      }
    });
    return hit;
  }, []);

  const [dragOrderKeys, setDragOrderKeys] = useState<string[] | null>(null);
  const [activeRowKey, setActiveRowKey] = useState<string | null>(null);
  // Set while the dragged card hovers the middle band of another card — that
  // card is highlighted as the aggregation drop target.
  const [aggregateTargetKey, setAggregateTargetKey] = useState<string | null>(null);

  // Hydrate the aggregation snapshot once we know who the user is.
  useEffect(() => {
    if (userId) void hydrateAggregations(userId);
  }, [hydrateAggregations, userId]);

  // Fold the server structure into local state, preserving each card's active
  // tab. Record the synced key so the save effect below doesn't echo it back.
  useEffect(() => {
    if (!aggregationsHydrated) return;
    const syncedGroups = readSyncedProjectCardGroups(snapshot.scopes[PROJECT_CARD_GROUPS_SCOPE] ?? []);
    lastSyncedKeyRef.current = projectCardGroupsSyncKey(syncedGroups);
    setAggregations((prev) => mergeSyncedProjectCardGroups(prev, syncedGroups));
  }, [snapshot, aggregationsHydrated]);

  // Persist structural changes (membership/labels). Active-tab-only changes do
  // not alter the synced key, so they stay device-local and skip the network.
  useEffect(() => {
    if (!userId || !aggregationsHydrated) return;
    const key = projectCardGroupsSyncKey(aggregations);
    if (key === lastSyncedKeyRef.current) return;
    lastSyncedKeyRef.current = key;
    void saveAggregationsScope(userId, PROJECT_CARD_GROUPS_SCOPE, aggregations);
  }, [aggregations, aggregationsHydrated, saveAggregationsScope, userId]);

  const resolveGroup = useCallback((projectId: string): ProjectGroup | null => {
    for (const group of visibleGroups) {
      if (group.members.some((member) => member.id === projectId)) return group;
    }
    return null;
  }, [visibleGroups]);

  const baseRows = useMemo(
    () => buildProjectCardRows(visibleGroups, aggregations, resolveGroup),
    [aggregations, resolveGroup, visibleGroups],
  );

  const orderedRows = useMemo(() => {
    if (!dragOrderKeys) return baseRows;
    const byKey = new Map<string, Row>();
    for (const row of baseRows) byKey.set(rowKeyOf(row), row);
    const seen = new Set<string>();
    const ordered = dragOrderKeys.flatMap((key) => {
      const row = byKey.get(key);
      if (!row) return [];
      seen.add(key);
      return [row];
    });
    for (const row of baseRows) {
      if (!seen.has(rowKeyOf(row))) ordered.push(row);
    }
    return ordered;
  }, [baseRows, dragOrderKeys]);

  const rowByKey = useMemo(() => {
    const map = new Map<string, Row>();
    for (const row of orderedRows) map.set(rowKeyOf(row), row);
    return map;
  }, [orderedRows]);

  const activeRow = activeRowKey ? rowByKey.get(activeRowKey) ?? null : null;

  const commitOrder = useCallback((nextRows: Row[]) => {
    const reorderedVisibleIds = flattenRowsToProjectIds(nextRows);
    const visibleIdSet = new Set(reorderedVisibleIds);
    const queue = [...reorderedVisibleIds];
    const ids = projects.map((project) =>
      visibleIdSet.has(project.id) ? queue.shift()! : project.id,
    );
    void reorderProjects(ids);
  }, [projects, reorderProjects]);

  const resetDragState = useCallback(() => {
    setActiveRowKey(null);
    setDragOrderKeys(null);
    setAggregateTargetKey(null);
  }, []);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveRowKey(String(event.active.id));
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    const activeId = String(event.active.id);
    const draggedRow = rowByKey.get(activeId);
    if (!aggregationsHydrated || draggedRow?.type !== 'group') {
      setAggregateTargetKey(null);
      return;
    }

    const pointer = readDragPointer(event);
    const hit = pointer ? findRowAtPointer(pointer, activeId) : null;
    const targetRow = hit ? rowByKey.get(hit.key) : null;
    if (!pointer || !hit || !targetRow || hit.rect.height <= 0) {
      setAggregateTargetKey(null);
      return;
    }

    const ratio = (pointer.y - hit.rect.top) / hit.rect.height;
    if (ratio > AGGREGATE_BAND_MIN && ratio < AGGREGATE_BAND_MAX) {
      setAggregateTargetKey(hit.key);
      return;
    }

    setAggregateTargetKey(null);
  }, [aggregationsHydrated, findRowAtPointer, rowByKey]);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    resetDragState();
  }, [resetDragState]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const activeId = String(event.active.id);
    const draggedRow = rowByKey.get(activeId);
    const pointer = readDragPointer(event);
    const pointerHit = pointer ? findRowAtPointer(pointer, activeId) : null;
    const pointerHitRatio = pointerHit && pointer && pointerHit.rect.height > 0
      ? (pointer.y - pointerHit.rect.top) / pointerHit.rect.height
      : null;
    const aggregateDropTargetKey = (
      aggregationsHydrated
      && draggedRow?.type === 'group'
      && pointerHit
      && pointerHitRatio !== null
      && pointerHitRatio > AGGREGATE_BAND_MIN
      && pointerHitRatio < AGGREGATE_BAND_MAX
    )
      ? pointerHit.key
      : null;

    // Aggregate branch: dropped a plain card onto the middle of another card.
    // Recompute the target from the release coordinates so a final fast move
    // cannot use stale highlight state or a transformed dnd-kit collision rect.
    if (aggregateDropTargetKey && draggedRow?.type === 'group') {
      const targetRow = rowByKey.get(aggregateDropTargetKey);
      const draggedProjectId = primaryProjectIdOf(draggedRow.group);
      if (targetRow && targetRow.type === 'group' && targetRow.group.key !== draggedRow.group.key) {
        const newId = `projcard-${maxProjectCardGroupIdCounter(aggregations) + 1}`;
        setAggregations((prev) =>
          createProjectCardGroup(prev, newId, primaryProjectIdOf(targetRow.group), draggedProjectId),
        );
        resetDragState();
        return;
      }
      if (targetRow && targetRow.type === 'aggregation') {
        setAggregations((prev) => addProjectToGroup(prev, targetRow.id, draggedProjectId));
        resetDragState();
        return;
      }
    }

    // Reorder branch.
    const overId = pointerHit?.key ?? (event.over ? String(event.over.id) : null);
    if (!overId) {
      resetDragState();
      return;
    }
    const nextRows = reorderRowsLocally(orderedRows, activeId, overId);
    const nextOrderKeys = nextRows.map(rowKeyOf);
    setDragOrderKeys(nextOrderKeys);
    setActiveRowKey(null);
    setAggregateTargetKey(null);

    const previousOrder = baseRows.map(rowKeyOf).join(',');
    const nextOrder = nextOrderKeys.join(',');
    if (previousOrder === nextOrder) return;

    await commitOrder(nextRows);
  }, [aggregations, aggregationsHydrated, baseRows, commitOrder, findRowAtPointer, orderedRows, resetDragState, rowByKey]);

  const renderRow = useCallback((row: Row, forOverlay = false): ReactElement => {
    if (row.type === 'group') {
      const group = row.group;
      const groupSelected = group.members.some((member) => member.id === selectedProjectId);
      const groupHidden = group.members.every((member) => hiddenProjectIdSet.has(member.id));
      return (
        <ProjectItem
          project={group.members[0]}
          mergedMembers={group.members}
          sortableId={group.key}
          isSelected={groupSelected}
          isHidden={groupHidden}
          onSelect={() => setSelectedProjectId(group.members[0].id)}
          onHide={hideProject}
          onUnhide={unhideProject}
          dragDisabled={forOverlay || isLoading}
        />
      );
    }

    const activeTab = row.tabs.find((tab) => tab.projectId === row.activeProjectId) ?? row.tabs[0];
    const activeGroup = activeTab.group;
    const groupSelected = activeGroup.members.some((member) => member.id === selectedProjectId);
    const groupHidden = activeGroup.members.every((member) => hiddenProjectIdSet.has(member.id));
    const tabs: ProjectCardTab[] = row.tabs.map((tab) => ({
      projectId: tab.projectId,
      name: tab.group.name,
      label: row.labels[tab.projectId] ?? null,
    }));
    return (
      <ProjectItem
        project={activeGroup.members[0]}
        mergedMembers={activeGroup.members}
        sortableId={`agg:${row.id}`}
        isSelected={groupSelected}
        isHidden={groupHidden}
        onSelect={() => setSelectedProjectId(activeGroup.members[0].id)}
        onHide={hideProject}
        onUnhide={unhideProject}
        dragDisabled={forOverlay || isLoading}
        aggregation={{
          id: row.id,
          tabs,
          activeProjectId: activeTab.projectId,
          onSelectTab: (projectId) => {
            setAggregations((prev) => setActiveProjectCardTab(prev, row.id, projectId));
            setSelectedProjectId(projectId);
          },
          onEjectTab: (projectId) =>
            setAggregations((prev) => ejectProjectFromGroup(prev, row.id, projectId)),
          onRenameTab: (projectId, label) =>
            setAggregations((prev) => setProjectCardTabLabel(prev, row.id, projectId, label)),
        }}
      />
    );
  }, [hiddenProjectIdSet, hideProject, isLoading, selectedProjectId, setSelectedProjectId, unhideProject]);

  if (isLoading && projects.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  if (visibleProjects.length === 0) {
    const emptyTitle = projects.length === 0
      ? 'No projects yet'
      : onlineProjects.length === 0
        ? 'No online projects'
        : 'No visible projects';
    const emptyDescription = projects.length === 0
      ? 'Create a project to organize your tasks'
      : onlineProjects.length === 0
        ? 'Reconnect a daemon to show its projects'
        : 'Double-click Projects to show hidden projects';

    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted">
        <svg className="size-16 mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <p className="text-lg font-medium">{emptyTitle}</p>
        <p className="text-sm mt-1">{emptyDescription}</p>
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={orderedRows.map(rowKeyOf)} strategy={stableProjectSortingStrategy}>
        <div className="space-y-3">
          {orderedRows.map((row) => {
            const key = rowKeyOf(row);
            const isAggregateTarget = aggregateTargetKey === key;
            return (
              <div
                key={key}
                ref={setRowRef(key)}
                className={isAggregateTarget ? 'rounded-2xl ring-2 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--paper)]' : undefined}
              >
                {renderRow(row)}
              </div>
            );
          })}
        </div>
      </SortableContext>

      <DragOverlay>
        {activeRow ? renderRow(activeRow, true) : null}
      </DragOverlay>
    </DndContext>
  );
}

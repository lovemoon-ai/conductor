'use client';

import { useCallback, useMemo, useState } from 'react';
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
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Project, ProjectGroup } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '../store';
import { ProjectItem } from './ProjectItem';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import {
  flattenGroupsToProjectIds,
  reorderProjectGroupsLocally,
} from './project-list-utils';
import { getProjectListVisibility } from '../utils/project-list-order';

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
  // Compute groups (one card per merged set) from the currently visible
  // projects. Single-member groups behave like the old single-project rows;
  // merged groups render one card with multiple daemon badges.
  const [dragOrderKeys, setDragOrderKeys] = useState<string[] | null>(null);
  const [activeGroupKey, setActiveGroupKey] = useState<string | null>(null);

  const orderedVisibleGroups = useMemo(() => {
    if (!dragOrderKeys) {
      return visibleGroups;
    }

    const byKey = new Map<string, ProjectGroup>();
    for (const group of visibleGroups) {
      byKey.set(group.key, group);
    }

    const seen = new Set<string>();
    const ordered = dragOrderKeys.flatMap((key) => {
      const group = byKey.get(key);
      if (!group) {
        return [];
      }
      seen.add(key);
      return [group];
    });

    for (const group of visibleGroups) {
      if (!seen.has(group.key)) {
        ordered.push(group);
      }
    }

    return ordered;
  }, [dragOrderKeys, visibleGroups]);

  const activeGroup = useMemo(() => {
    if (!activeGroupKey) {
      return null;
    }
    return orderedVisibleGroups.find((group) => group.key === activeGroupKey) ?? null;
  }, [activeGroupKey, orderedVisibleGroups]);

  const commitOrder = useCallback((nextVisibleGroups: ProjectGroup[]) => {
    // Reorder uses individual project ids — flatten the groups back to a flat
    // member-by-member list, then splice it back into the full project order
    // (replacing the visible slots while leaving hidden/offline projects
    // untouched).
    const reorderedVisibleIds = flattenGroupsToProjectIds(nextVisibleGroups);
    const visibleIdSet = new Set(reorderedVisibleIds);
    const queue = [...reorderedVisibleIds];
    const ids = projects.map((project) =>
      visibleIdSet.has(project.id) ? queue.shift()! : project.id,
    );
    void reorderProjects(ids);
  }, [projects, reorderProjects]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveGroupKey(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const nextVisibleGroups = reorderProjectGroupsLocally(orderedVisibleGroups, activeId, overId);
    setDragOrderKeys(nextVisibleGroups.map((group) => group.key));
  }, [orderedVisibleGroups]);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveGroupKey(null);
    setDragOrderKeys(null);
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    if (!event.over) {
      setActiveGroupKey(null);
      setDragOrderKeys(null);
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const nextVisibleGroups = reorderProjectGroupsLocally(orderedVisibleGroups, activeId, overId);
    const nextOrderKeys = nextVisibleGroups.map((group) => group.key);
    setDragOrderKeys(nextOrderKeys);
    setActiveGroupKey(null);

    const previousOrder = visibleGroups.map((group) => group.key).join(',');
    const nextOrder = nextOrderKeys.join(',');
    if (previousOrder === nextOrder) {
      return;
    }

    await commitOrder(nextVisibleGroups);
  }, [commitOrder, orderedVisibleGroups, visibleGroups]);

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
      onDragOver={handleDragOver}
      onDragCancel={handleDragCancel}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={orderedVisibleGroups.map((group) => group.key)} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {orderedVisibleGroups.map((group) => {
            const primary = group.members[0];
            // The card "selects" the primary member; the issues view derives
            // the full member set via `useSelectedProjectGroupIds`.
            const groupSelected = group.members.some((member) => member.id === selectedProjectId);
            // A group is hidden iff every member is hidden — partially-hidden
            // groups still render so the user can act on visible members.
            const groupHidden = group.members.every((member) => hiddenProjectIdSet.has(member.id));
            return (
              <ProjectItem
                key={group.key}
                project={primary}
                mergedMembers={group.members}
                sortableId={group.key}
                isSelected={groupSelected}
                isHidden={groupHidden}
                onSelect={() => setSelectedProjectId(primary.id)}
                onHide={hideProject}
                onUnhide={unhideProject}
                dragDisabled={isLoading}
              />
            );
          })}
        </div>
      </SortableContext>

      <DragOverlay>
        {activeGroup ? (
          <ProjectItem
            project={activeGroup.members[0]}
            mergedMembers={activeGroup.members}
            sortableId={activeGroup.key}
            isSelected={activeGroup.members.some((member) => member.id === selectedProjectId)}
            isHidden={activeGroup.members.every((member) => hiddenProjectIdSet.has(member.id))}
            onSelect={() => setSelectedProjectId(activeGroup.members[0].id)}
            onHide={hideProject}
            onUnhide={unhideProject}
            dragDisabled
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

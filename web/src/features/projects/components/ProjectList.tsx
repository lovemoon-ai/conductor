'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import type { Project } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '../store';
import { ProjectItem } from './ProjectItem';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { reorderProjectsLocally } from './project-list-utils';

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

const getProjectDaemonHost = (project: Project): string | null => {
  if (typeof project.daemonHost !== 'string') {
    return null;
  }
  return project.daemonHost.trim() || null;
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
  const onlineDaemonHosts = new Set(
    agents
      .map((agent) => agent.host.trim())
      .filter(Boolean),
  );
  const hiddenProjectIdSet = useMemo(() => new Set(hiddenProjectIds), [hiddenProjectIds]);
  const onlineProjects = projects.filter((project) => {
    const daemonHost = getProjectDaemonHost(project);
    return !daemonHost || onlineDaemonHosts.has(daemonHost);
  });
  const visibleProjects = onlineProjects.filter((project) => (
    showHiddenProjects || !hiddenProjectIdSet.has(project.id)
  ));
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
  const [orderedVisibleProjects, setOrderedVisibleProjects] = useState<Project[]>(visibleProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const visibleProjectIds = useMemo(() => visibleProjects.map((project) => project.id).join(','), [visibleProjects]);

  const prevVisibleProjectsRef = useRef(visibleProjects);

  useEffect(() => {
    if (activeProjectId !== null) {
      return;
    }

    const prev = prevVisibleProjectsRef.current;
    prevVisibleProjectsRef.current = visibleProjects;

    // Same reference — nothing changed
    if (prev === visibleProjects) {
      return;
    }

    setOrderedVisibleProjects((current) => {
      const currentIds = current.map((p) => p.id).join(',');
      if (currentIds !== visibleProjectIds) {
        // ID set changed — full reset
        return visibleProjects;
      }
      // IDs unchanged — refresh object references so renamed/updated projects render
      const byId = new Map<string, Project>();
      for (const p of visibleProjects) byId.set(p.id, p);
      const next = current.map((p) => byId.get(p.id) ?? p);
      // Only return a new array if something actually changed
      const changed = next.some((p, i) => p !== current[i]);
      return changed ? next : current;
    });
  }, [activeProjectId, visibleProjectIds, visibleProjects]);

  const activeProject = useMemo(() => {
    if (!activeProjectId) {
      return null;
    }
    return orderedVisibleProjects.find((project) => project.id === activeProjectId)
      ?? visibleProjects.find((project) => project.id === activeProjectId)
      ?? null;
  }, [activeProjectId, orderedVisibleProjects, visibleProjects]);

  const commitOrder = useCallback((nextVisibleProjects: Project[]) => {
    const visibleIdSet = new Set(visibleProjects.map((project) => project.id));
    const reorderedVisibleIds = nextVisibleProjects.map((project) => project.id);
    const ids = projects.map((project) => (
      visibleIdSet.has(project.id)
        ? reorderedVisibleIds.shift()!
        : project.id
    ));
    void reorderProjects(ids);
  }, [projects, reorderProjects, visibleProjects]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveProjectId(String(event.active.id));
  }, []);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    if (!event.over) {
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    setOrderedVisibleProjects((current) => reorderProjectsLocally(current, activeId, overId));
  }, []);

  const handleDragCancel = useCallback((_event: DragCancelEvent) => {
    setActiveProjectId(null);
    setOrderedVisibleProjects(visibleProjects);
  }, [visibleProjects]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    if (!event.over) {
      setActiveProjectId(null);
      setOrderedVisibleProjects(visibleProjects);
      return;
    }

    const activeId = String(event.active.id);
    const overId = String(event.over.id);
    const nextVisibleProjects = reorderProjectsLocally(orderedVisibleProjects, activeId, overId);
    setOrderedVisibleProjects(nextVisibleProjects);
    setActiveProjectId(null);

    const previousOrder = visibleProjects.map((project) => project.id).join(',');
    const nextOrder = nextVisibleProjects.map((project) => project.id).join(',');
    if (previousOrder === nextOrder) {
      return;
    }

    await commitOrder(nextVisibleProjects);
  }, [commitOrder, orderedVisibleProjects, visibleProjects]);

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
        <svg className="w-16 h-16 mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
      <SortableContext items={orderedVisibleProjects.map((project) => project.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-3">
          {orderedVisibleProjects.map((project) => (
            <ProjectItem
              key={project.id}
              project={project}
              isSelected={selectedProjectId === project.id}
              isHidden={hiddenProjectIdSet.has(project.id)}
              onSelect={setSelectedProjectId}
              onHide={hideProject}
              onUnhide={unhideProject}
              dragDisabled={isLoading}
            />
          ))}
        </div>
      </SortableContext>

      <DragOverlay>
        {activeProject ? (
          <ProjectItem
            project={activeProject}
            isSelected={selectedProjectId === activeProject.id}
            isHidden={hiddenProjectIdSet.has(activeProject.id)}
            onSelect={setSelectedProjectId}
            onHide={hideProject}
            onUnhide={unhideProject}
            dragDisabled
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

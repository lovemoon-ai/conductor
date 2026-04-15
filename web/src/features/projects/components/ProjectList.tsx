'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
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

const getProjectDaemonHost = (project: Project): string | null => {
  if (typeof project.daemonHost !== 'string') {
    return null;
  }
  return project.daemonHost.trim() || null;
};

export function ProjectList() {
  const { projects, isLoading, selectedProjectId, setSelectedProjectId, reorderProjects } = useProjectsStore();
  const agents = useAgentsStore((state) => state.agents);
  const onlineDaemonHosts = new Set(
    agents
      .map((agent) => agent.host.trim())
      .filter(Boolean),
  );
  const visibleProjects = projects.filter((project) => {
    const daemonHost = getProjectDaemonHost(project);
    return !daemonHost || onlineDaemonHosts.has(daemonHost);
  });
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const [orderedVisibleProjects, setOrderedVisibleProjects] = useState<Project[]>(visibleProjects);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  const visibleProjectIds = useMemo(() => visibleProjects.map((project) => project.id).join(','), [visibleProjects]);

  useEffect(() => {
    if (activeProjectId !== null) {
      return;
    }

    const currentIds = orderedVisibleProjects.map((project) => project.id).join(',');
    if (currentIds !== visibleProjectIds) {
      setOrderedVisibleProjects(visibleProjects);
    }
  }, [activeProjectId, orderedVisibleProjects, visibleProjectIds, visibleProjects]);

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
    const emptyTitle = projects.length === 0 ? 'No projects yet' : 'No online projects';
    const emptyDescription = projects.length === 0
      ? 'Create a project to organize your tasks'
      : 'Reconnect a daemon to show its projects';

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
              onSelect={setSelectedProjectId}
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
            onSelect={setSelectedProjectId}
            dragDisabled
          />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

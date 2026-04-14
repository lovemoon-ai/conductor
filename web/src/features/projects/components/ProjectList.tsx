'use client';

import { useCallback, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import type { Project } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '../store';
import { ProjectItem } from './ProjectItem';
import { DragHandle } from './DragHandle';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

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

  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragSourceIdRef = useRef<string | null>(null);
  const dragCounterRef = useRef(0);

  const handleDragStart = useCallback((e: DragEvent<HTMLDivElement>, projectId: string) => {
    dragSourceIdRef.current = projectId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', projectId);
  }, []);

  const handleDragEnter = useCallback((index: number) => {
    dragCounterRef.current += 1;
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setDragOverIndex(null);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>, targetIndex: number) => {
      e.preventDefault();
      const sourceId = e.dataTransfer.getData('text/plain') || dragSourceIdRef.current;
      setDragOverIndex(null);
      dragCounterRef.current = 0;
      dragSourceIdRef.current = null;

      if (!sourceId) return;

      const visibleIds = visibleProjects.map((p) => p.id);
      const fromIndex = visibleIds.indexOf(sourceId);
      if (fromIndex === -1 || fromIndex === targetIndex) return;

      visibleIds.splice(fromIndex, 1);
      const adjustedTargetIndex = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
      visibleIds.splice(adjustedTargetIndex, 0, sourceId);

      const visibleIdSet = new Set(visibleProjects.map((p) => p.id));
      const reorderedVisibleIds = [...visibleIds];
      const ids = projects.map((project) =>
        visibleIdSet.has(project.id)
          ? reorderedVisibleIds.shift()!
          : project.id,
      );
      void reorderProjects(ids);
    },
    [projects, visibleProjects, reorderProjects],
  );

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    dragCounterRef.current = 0;
    dragSourceIdRef.current = null;
  }, []);

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
    <div className="space-y-3">
      {visibleProjects.map((project, index) => (
        <div
          key={project.id}
          onDragOver={handleDragOver}
          onDragEnter={() => handleDragEnter(index)}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, index)}
          onDragEnd={handleDragEnd}
        >
          {dragOverIndex === index && dragSourceIdRef.current !== project.id ? (
            <div className="h-0.5 rounded-full bg-[var(--accent)] -mt-1.5 mb-1.5" />
          ) : null}
          <ProjectItem
            project={project}
            isSelected={selectedProjectId === project.id}
            onSelect={setSelectedProjectId}
            dragHandle={<DragHandle projectId={project.id} onDragStart={handleDragStart} />}
          />
        </div>
      ))}
      <div
        className="h-3"
        onDragOver={handleDragOver}
        onDragEnter={() => handleDragEnter(visibleProjects.length)}
        onDragLeave={handleDragLeave}
        onDrop={(e) => handleDrop(e, visibleProjects.length)}
        onDragEnd={handleDragEnd}
        data-testid="project-list-end-dropzone"
      >
        {dragOverIndex === visibleProjects.length ? (
          <div className="h-0.5 rounded-full bg-[var(--accent)]" />
        ) : null}
      </div>
    </div>
  );
}

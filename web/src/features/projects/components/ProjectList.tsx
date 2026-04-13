'use client';

import type { Project } from '@/shared/types';
import { useAgentsStore } from '@/features/agents';
import { useProjectsStore } from '../store';
import { ProjectItem } from './ProjectItem';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

const getProjectDaemonHost = (project: Project): string | null => {
  if (typeof project.daemonHost !== 'string') {
    return null;
  }
  return project.daemonHost.trim() || null;
};

export function ProjectList() {
  const { projects, isLoading, selectedProjectId, setSelectedProjectId } = useProjectsStore();
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
      {visibleProjects.map((project) => (
        <ProjectItem
          key={project.id}
          project={project}
          isSelected={selectedProjectId === project.id}
          onSelect={setSelectedProjectId}
        />
      ))}
    </div>
  );
}

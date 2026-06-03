'use client';

import { useState, useEffect } from 'react';
import { Header } from '@/components/layout/Header';
import { ProjectList } from '@/features/projects';
import { CreateProjectDialog } from '@/features/projects';
import { useProjectsStore } from '@/features/projects';
import { RefreshIcon } from '@/features/tasks';

export default function ProjectsPage() {
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);
  const refreshProject = useProjectsStore((state) => state.refreshProject);
  const isLoading = useProjectsStore((state) => state.isLoading);
  const setSelectedProjectId = useProjectsStore((state) => state.setSelectedProjectId);
  const showHiddenProjects = useProjectsStore((state) => state.showHiddenProjects);
  const toggleShowHiddenProjects = useProjectsStore((state) => state.toggleShowHiddenProjects);
  const [isRefreshingProjects, setIsRefreshingProjects] = useState(false);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleRefreshProjects = async () => {
    if (isLoading || isRefreshingProjects) {
      return;
    }
    setIsRefreshingProjects(true);
    try {
      await fetchProjects();
      const latestProjects = useProjectsStore.getState().projects;
      const refreshableProjectIds = Array.from(
        new Set(
          latestProjects
            .filter((project) =>
              Boolean(project.daemonHost?.trim()) && Boolean(project.workspacePath?.trim()),
            )
            .map((project) => project.id),
        ),
      );
      if (refreshableProjectIds.length > 0) {
        await Promise.allSettled(
          refreshableProjectIds.map((projectId) => refreshProject(projectId)),
        );
        await fetchProjects();
      }
    } finally {
      setIsRefreshingProjects(false);
    }
  };

  const isRefreshBusy = isLoading || isRefreshingProjects;

  return (
    <>
      <Header
        title="Projects"
        compact
        onTitleClick={() => setSelectedProjectId(null)}
        onTitleDoubleClick={toggleShowHiddenProjects}
        titleDoubleClickHint={showHiddenProjects
          ? 'Click to clear project selection. Double-click to hide hidden projects.'
          : 'Click to clear project selection. Double-click to show hidden projects.'}
        actions={
          <div className="flex items-center gap-2">
            <button type="button"
              onClick={() => void handleRefreshProjects()}
              disabled={isRefreshBusy}
              aria-label={isRefreshBusy ? 'Refreshing projects' : 'Refresh projects'}
              title={isRefreshBusy ? 'Refreshing projects' : 'Refresh projects'}
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshIcon spinning={isRefreshBusy} />
            </button>
            <button type="button"
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create project"
              title="Create project"
              className="webapp-btn-primary flex items-center justify-center p-2.5 text-sm"
            >
              <svg className="size-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 webapp-scrollbar">
        <ProjectList />
      </div>

      <CreateProjectDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
      />
    </>
  );
}

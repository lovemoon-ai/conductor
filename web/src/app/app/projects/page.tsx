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
  const isLoading = useProjectsStore((state) => state.isLoading);
  const setSelectedProjectId = useProjectsStore((state) => state.setSelectedProjectId);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  return (
    <>
      <Header
        title="Projects"
        compact
        onTitleDoubleClick={() => setSelectedProjectId(null)}
        titleDoubleClickHint="Double-click to show tasks from all projects"
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchProjects()}
              disabled={isLoading}
              aria-label={isLoading ? 'Refreshing projects' : 'Refresh projects'}
              title={isLoading ? 'Refreshing projects' : 'Refresh projects'}
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshIcon spinning={isLoading} />
            </button>
            <button
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create project"
              title="Create project"
              className="webapp-btn-primary flex items-center justify-center p-2.5 text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

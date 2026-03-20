'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/conductor/layout/Header';
import {
  GridIcon,
  ListIcon,
  RefreshIcon,
  readStoredTaskListViewMode,
  TaskList,
  TASK_LIST_VIEW_STORAGE_KEY,
  type TaskListViewMode,
} from '@/components/conductor/tasks/TaskList';
import { CreateTaskDialog } from '@/components/conductor/tasks/CreateTaskDialog';
import { useTasksStore } from '@/lib/conductor/stores/tasks';
import { useProjectsStore } from '@/lib/conductor/stores/projects';

function TasksPageContent() {
  const searchParams = useSearchParams();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [viewMode, setViewMode] = useState<TaskListViewMode>(() => readStoredTaskListViewMode());
  const setProjectFilter = useTasksStore((state) => state.setProjectFilter);
  const fetchTasks = useTasksStore((state) => state.fetchTasks);
  const isLoading = useTasksStore((state) => state.isLoading);
  const currentProjectFilter = useTasksStore((state) => state.currentProjectFilter);
  const taskCount = useTasksStore((state) => state.tasks.length);
  const projects = useProjectsStore((state) => state.projects);
  const projectId = searchParams.get('projectId');
  const currentProjectName = projectId
    ? projects.find((project) => project.id === projectId)?.name
    : null;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    window.localStorage.setItem(TASK_LIST_VIEW_STORAGE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    setProjectFilter(projectId || null);
  }, [projectId, setProjectFilter]);

  const handleRefresh = () => {
    fetchTasks(currentProjectFilter ?? undefined, { recoverStale: true });
  };

  return (
    <>
      <Header
        title={currentProjectName ? `Task ${taskCount} · ${currentProjectName}` : `Task ${taskCount}`}
        compact
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-xl bg-paper/80 p-1">
              <button
                type="button"
                onClick={() => setViewMode('list')}
                aria-label="List view"
                title="List view"
                aria-pressed={viewMode === 'list'}
                className={`inline-flex items-center rounded-lg p-2 text-xs font-medium transition-colors ${
                  viewMode === 'list'
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <ListIcon />
              </button>
              <button
                type="button"
                onClick={() => setViewMode('grid')}
                aria-label="Grid view"
                title="Grid view"
                aria-pressed={viewMode === 'grid'}
                className={`inline-flex items-center rounded-lg p-2 text-xs font-medium transition-colors ${
                  viewMode === 'grid'
                    ? 'bg-panel text-ink shadow-sm'
                    : 'text-muted hover:text-ink'
                }`}
              >
                <GridIcon />
              </button>
            </div>

            <button
              onClick={handleRefresh}
              disabled={isLoading}
              aria-label={isLoading ? 'Refreshing tasks' : 'Refresh tasks'}
              title={isLoading ? 'Refreshing tasks' : 'Refresh tasks'}
              className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
            >
              <RefreshIcon spinning={isLoading} />
            </button>

            <button
              onClick={() => setShowCreateDialog(true)}
              aria-label="Create task"
              title="Create task"
              className="webapp-btn-primary flex items-center justify-center p-2 text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 pb-4 pt-4 webapp-scrollbar">
        <TaskList viewMode={viewMode} />
      </div>

      <CreateTaskDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
      />
    </>
  );
}

export default function TasksPage() {
  return (
    <Suspense fallback={null}>
      <TasksPageContent />
    </Suspense>
  );
}

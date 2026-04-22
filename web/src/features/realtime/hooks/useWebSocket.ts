'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/features/auth';
import { useProjectsStore } from '@/features/projects';
import { useWebSocketStore } from '../store';
import { useTasksStore } from '@/features/tasks';

export function useWebSocket() {
  const session = useAuthStore((state) => state.session);
  const { status, connect, disconnect } = useWebSocketStore();
  const fetchTasks = useTasksStore((state) => state.fetchTasks);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);

  useEffect(() => {
    if (!session?.userToken) {
      return;
    }

    connect(session.userToken);

    // Fetch tasks on first connect for the current session.
    fetchTasks(useTasksStore.getState().currentProjectFilter ?? undefined);

    return () => {
      // Don't disconnect on unmount to maintain connection across pages
    };
  }, [session?.userToken, connect, fetchTasks]);

  useEffect(() => {
    if (!session?.userToken || status !== 'connected') {
      return;
    }

    void fetchProjects();
  }, [status, session?.userToken, fetchProjects]);

  return { status, disconnect };
}

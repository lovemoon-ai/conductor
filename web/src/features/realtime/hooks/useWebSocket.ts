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
  const fetchTasksForProjects = useTasksStore((state) => state.fetchTasksForProjects);
  const fetchProjects = useProjectsStore((state) => state.fetchProjects);

  useEffect(() => {
    if (!session?.userToken) {
      return;
    }

    connect(session.userToken);

    // Fetch tasks on first connect for the current session. If the user is
    // currently viewing a cross-daemon merged group, replay the merged fetch
    // — otherwise a single-id fetch here would silently drop tasks from the
    // other daemons in the group.
    const tasksSnapshot = useTasksStore.getState();
    if (tasksSnapshot.currentProjectIds.length > 1) {
      void fetchTasksForProjects(tasksSnapshot.currentProjectIds);
    } else {
      void fetchTasks(tasksSnapshot.currentProjectFilter ?? undefined);
    }

    return () => {
      // Don't disconnect on unmount to maintain connection across pages
    };
  }, [session?.userToken, connect, fetchTasks, fetchTasksForProjects]);

  useEffect(() => {
    if (!session?.userToken || status !== 'connected') {
      return;
    }

    void fetchProjects();
  }, [status, session?.userToken, fetchProjects]);

  return { status, disconnect };
}

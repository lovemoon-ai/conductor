'use client';

import { useEffect } from 'react';
import { useAuthStore } from '../stores/auth';
import { useWebSocketStore } from '../stores/websocket';
import { useTasksStore } from '../stores/tasks';

export function useWebSocket() {
  const session = useAuthStore((state) => state.session);
  const { status, connect, disconnect } = useWebSocketStore();
  const fetchTasks = useTasksStore((state) => state.fetchTasks);

  useEffect(() => {
    if (session?.userToken) {
      connect(session.userToken);

      // Fetch tasks on connect
      fetchTasks(useTasksStore.getState().currentProjectFilter ?? undefined);
    }

    return () => {
      // Don't disconnect on unmount to maintain connection across pages
    };
  }, [session?.userToken, connect, fetchTasks]);

  return { status, disconnect };
}

import { create } from 'zustand';
import type { TaskRuntimeStatus } from '@/shared/types';

interface RuntimeState {
  byTask: Record<string, TaskRuntimeStatus>;
  setStatus: (status: TaskRuntimeStatus) => void;
  clearTask: (taskId: string) => void;
  clearAll: () => void;
}

const mergeRuntimeStatus = (
  existing: TaskRuntimeStatus | undefined,
  incoming: TaskRuntimeStatus,
): TaskRuntimeStatus => ({
  taskId: incoming.taskId,
  state: incoming.state,
  phase: incoming.phase,
  source: incoming.source ?? existing?.source,
  replyInProgress: incoming.replyInProgress,
  statusLine: incoming.statusLine,
  statusDoneLine: incoming.statusDoneLine,
  replyPreview: incoming.replyPreview,
  replyTo: incoming.replyTo,
  backend: incoming.backend ?? existing?.backend,
  threadId: incoming.threadId ?? existing?.threadId,
  daemon: incoming.daemon ?? existing?.daemon,
  pid: incoming.pid ?? existing?.pid,
  sessionId: incoming.sessionId ?? existing?.sessionId,
  sessionFilePath: incoming.sessionFilePath ?? existing?.sessionFilePath,
  tokenUsagePercent: incoming.tokenUsagePercent ?? existing?.tokenUsagePercent,
  contextUsagePercent: incoming.contextUsagePercent ?? existing?.contextUsagePercent,
  createdAt: incoming.createdAt ?? existing?.createdAt,
});

export const useRuntimeStore = create<RuntimeState>()((set) => ({
  byTask: {},

  setStatus: (status) => {
    if (!status?.taskId) {
      return;
    }
    set((state) => ({
      byTask: {
        ...state.byTask,
        [status.taskId]: mergeRuntimeStatus(state.byTask[status.taskId], status),
      },
    }));
  },

  clearTask: (taskId) => {
    if (!taskId) {
      return;
    }
    set((state) => {
      const { [taskId]: _ignored, ...rest } = state.byTask;
      return { byTask: rest };
    });
  },

  clearAll: () => {
    set({ byTask: {} });
  },
}));

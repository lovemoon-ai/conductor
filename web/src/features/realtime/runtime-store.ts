import { create } from 'zustand';
import type { TaskRuntimeStatus } from '@/shared/types';

interface RuntimeState {
  byTask: Record<string, TaskRuntimeStatus>;
  setStatus: (status: TaskRuntimeStatus) => void;
  clearTask: (taskId: string) => void;
  clearAll: () => void;
}

export const useRuntimeStore = create<RuntimeState>()((set) => ({
  byTask: {},

  setStatus: (status) => {
    if (!status?.taskId) {
      return;
    }
    set((state) => ({
      byTask: {
        ...state.byTask,
        [status.taskId]: status,
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

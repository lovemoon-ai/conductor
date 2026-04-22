import { create } from 'zustand';
import { getApiClient } from '@/shared/api/client';

export type TaskListPreferences = {
  tasksRunningOnly: boolean;
};

type UserPreferencesState = {
  taskListRunningOnly: boolean;
  taskListPreferencesHydrated: boolean;
  taskListPreferencesLoading: boolean;
  taskListPreferencesError: string | null;
  hydrateTaskListPreferences: () => Promise<void>;
  setTaskListRunningOnly: (value: boolean) => Promise<void>;
  applyTaskListPreferences: (preferences: TaskListPreferences) => void;
};

let taskListMutationSequence = 0;

const normalizeTaskListPreferences = (value: unknown): TaskListPreferences => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { tasksRunningOnly: false };
  }
  const record = value as Record<string, unknown>;
  const valueCandidate = Object.prototype.hasOwnProperty.call(record, 'tasksRunningOnly')
    ? record.tasksRunningOnly
    : record.tasks_running_only;
  return {
    tasksRunningOnly: valueCandidate === true,
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Failed to sync user preferences';

export const useUserPreferencesStore = create<UserPreferencesState>()((set, get) => ({
  taskListRunningOnly: false,
  taskListPreferencesHydrated: false,
  taskListPreferencesLoading: false,
  taskListPreferencesError: null,

  hydrateTaskListPreferences: async () => {
    const sequenceAtStart = taskListMutationSequence;
    set({ taskListPreferencesLoading: true, taskListPreferencesError: null });
    try {
      const preferences = normalizeTaskListPreferences(
        await getApiClient().get('/user-preferences/task-list'),
      );
      set((state) => ({
        taskListRunningOnly:
          taskListMutationSequence === sequenceAtStart
            ? preferences.tasksRunningOnly
            : state.taskListRunningOnly,
        taskListPreferencesHydrated: true,
        taskListPreferencesLoading: false,
        taskListPreferencesError: null,
      }));
    } catch (error) {
      set({
        taskListPreferencesHydrated: true,
        taskListPreferencesLoading: false,
        taskListPreferencesError: errorMessage(error),
      });
    }
  },

  setTaskListRunningOnly: async (value) => {
    taskListMutationSequence += 1;
    const sequence = taskListMutationSequence;
    const previousValue = get().taskListRunningOnly;
    set({
      taskListRunningOnly: value,
      taskListPreferencesHydrated: true,
      taskListPreferencesError: null,
    });
    try {
      const preferences = normalizeTaskListPreferences(
        await getApiClient().patch('/user-preferences/task-list', { tasksRunningOnly: value }),
      );
      set((state) => ({
        taskListRunningOnly:
          sequence === taskListMutationSequence
            ? preferences.tasksRunningOnly
            : state.taskListRunningOnly,
        taskListPreferencesError: null,
      }));
    } catch (error) {
      set((state) => ({
        taskListRunningOnly:
          sequence === taskListMutationSequence
            ? previousValue
            : state.taskListRunningOnly,
        taskListPreferencesError: errorMessage(error),
      }));
    }
  },

  applyTaskListPreferences: (preferences) => {
    taskListMutationSequence += 1;
    set({
      taskListRunningOnly: preferences.tasksRunningOnly,
      taskListPreferencesHydrated: true,
      taskListPreferencesError: null,
    });
  },
}));

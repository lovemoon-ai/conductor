import { create } from 'zustand';
import { getApiClient } from '@/shared/api/client';
import {
  readTaskCardGroupsSyncSnapshot,
  toSyncedTaskCardGroups,
  type TaskCardGroup,
  type TaskCardGroupsSyncSnapshot,
} from './utils/task-card-groups';

type TaskCardGroupsSyncState = {
  ownerUserId: string | null;
  snapshot: TaskCardGroupsSyncSnapshot;
  hydrated: boolean;
  loading: boolean;
  error: string | null;
  hydrate: (userId: string) => Promise<void>;
  saveScope: (userId: string, scope: string, groups: TaskCardGroup[]) => Promise<boolean>;
  applySnapshot: (snapshot: unknown, userId?: unknown) => void;
  reset: () => void;
};

const emptySnapshot = (): TaskCardGroupsSyncSnapshot =>
  readTaskCardGroupsSyncSnapshot(null);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Failed to sync task card groups';

let mutationSequence = 0;
let storeGeneration = 0;

export const useTaskCardGroupsSyncStore = create<TaskCardGroupsSyncState>()((set, get) => ({
  ownerUserId: null,
  snapshot: emptySnapshot(),
  hydrated: false,
  loading: false,
  error: null,

  hydrate: async (userId) => {
    if (get().ownerUserId !== userId) {
      mutationSequence += 1;
      storeGeneration += 1;
      set({ ownerUserId: userId, snapshot: emptySnapshot(), hydrated: false, loading: false, error: null });
    }
    const sequenceAtStart = mutationSequence;
    const generationAtStart = storeGeneration;
    set({ loading: true, error: null });
    try {
      const snapshot = readTaskCardGroupsSyncSnapshot(
        await getApiClient().get('/user-preferences/task-card-groups'),
      );
      set((state) => {
        if (storeGeneration !== generationAtStart) return state;
        return {
          snapshot: mutationSequence === sequenceAtStart ? snapshot : state.snapshot,
          hydrated: true,
          loading: false,
          error: null,
        };
      });
    } catch (error) {
      if (storeGeneration === generationAtStart) {
        set({ hydrated: true, loading: false, error: errorMessage(error) });
      }
    }
  },

  saveScope: async (userId, scope, groups) => {
    if (get().ownerUserId !== userId) {
      mutationSequence += 1;
      storeGeneration += 1;
      set({ ownerUserId: userId, snapshot: emptySnapshot(), hydrated: false, loading: false, error: null });
    }
    mutationSequence += 1;
    const generationAtStart = storeGeneration;
    try {
      const snapshot = readTaskCardGroupsSyncSnapshot(
        await getApiClient().patch('/user-preferences/task-card-groups', {
          scope,
          groups: toSyncedTaskCardGroups(groups),
        }),
      );
      if (storeGeneration !== generationAtStart) return false;
      set((state) => ({
        snapshot: snapshot.revision >= state.snapshot.revision ? snapshot : state.snapshot,
        hydrated: true,
        loading: false,
        error: null,
      }));
      return true;
    } catch (error) {
      if (storeGeneration === generationAtStart) {
        set({ hydrated: true, loading: false, error: errorMessage(error) });
      }
      return false;
    }
  },

  applySnapshot: (value, userIdValue) => {
    const userId = typeof userIdValue === 'string' && userIdValue ? userIdValue : null;
    const snapshot = readTaskCardGroupsSyncSnapshot(value);
    set((state) => {
      if (userId && state.ownerUserId && userId !== state.ownerUserId) return state;
      if (snapshot.revision < state.snapshot.revision) return state;
      return {
        ownerUserId: userId ?? state.ownerUserId,
        snapshot,
        hydrated: true,
        loading: false,
        error: null,
      };
    });
  },

  reset: () => {
    mutationSequence += 1;
    storeGeneration += 1;
    set({ ownerUserId: null, snapshot: emptySnapshot(), hydrated: false, loading: false, error: null });
  },
}));

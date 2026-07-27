import { create } from 'zustand';
import { getApiClient } from '@/shared/api/client';
import type { AchievedTaskSummary, AchievedTasksPage } from '@/shared/types';

export const ACHIEVED_TASKS_PAGE_SIZE = 10;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Failed to load achieved tasks';

// Monotonic token so a slow response from an earlier keystroke can never
// overwrite results from a newer query (last-write-wins by request order).
let requestToken = 0;

interface AchievedTasksState {
  query: string;
  projectIds: string[];
  tasks: AchievedTaskSummary[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  loading: boolean;
  hydrated: boolean;
  error: string | null;
  search: (query: string, page?: number, projectIds?: string[]) => Promise<void>;
  refresh: () => Promise<void>;
  removeTask: (taskId: string) => void;
}

export const useAchievedTasksStore = create<AchievedTasksState>()((set, get) => ({
  query: '',
  projectIds: [],
  tasks: [],
  total: 0,
  page: 1,
  pageSize: ACHIEVED_TASKS_PAGE_SIZE,
  totalPages: 0,
  loading: false,
  hydrated: false,
  error: null,

  search: async (query: string, page = 1, projectIds = get().projectIds) => {
    const token = ++requestToken;
    const normalizedPage = Math.max(1, Math.floor(page));
    const normalizedProjectIds = [...new Set(
      projectIds.flatMap((projectId) => {
        const normalized = projectId.trim();
        return normalized ? [normalized] : [];
      }),
    )];
    set({
      query: query.trim(),
      projectIds: normalizedProjectIds,
      page: normalizedPage,
      loading: true,
      error: null,
    });
    try {
      const params = new URLSearchParams();
      const trimmed = query.trim();
      if (trimmed) params.set('q', trimmed);
      if (normalizedProjectIds.length === 1) {
        params.set('projectId', normalizedProjectIds[0]);
      } else if (normalizedProjectIds.length > 1) {
        params.set('projectIds', normalizedProjectIds.join(','));
      }
      params.set('page', String(normalizedPage));
      params.set('limit', String(ACHIEVED_TASKS_PAGE_SIZE));
      const response = await getApiClient().get<Partial<AchievedTasksPage>>(
        `/tasks/achieved?${params.toString()}`,
      );
      if (token !== requestToken) return;
      const tasks = Array.isArray(response?.tasks) ? response.tasks : [];
      const total = typeof response?.total === 'number' ? response.total : tasks.length;
      const pageSize =
        typeof response?.pageSize === 'number' ? response.pageSize : ACHIEVED_TASKS_PAGE_SIZE;
      set({
        tasks,
        total,
        page: typeof response?.page === 'number' ? response.page : normalizedPage,
        pageSize,
        totalPages:
          typeof response?.totalPages === 'number'
            ? response.totalPages
            : Math.ceil(total / pageSize),
        loading: false,
        hydrated: true,
        error: null,
      });
    } catch (error) {
      if (token !== requestToken) return;
      set({ loading: false, hydrated: true, error: errorMessage(error) });
    }
  },

  refresh: async () => {
    const { query, page, projectIds } = get();
    await get().search(query, page, projectIds);
    const refreshed = get();
    if (
      !refreshed.error &&
      refreshed.page > 1 &&
      refreshed.tasks.length === 0 &&
      refreshed.total > 0
    ) {
      await refreshed.search(refreshed.query, refreshed.page - 1, refreshed.projectIds);
    }
  },

  removeTask: (taskId: string) => {
    set((state) => {
      const tasks = state.tasks.filter((task) => task.id !== taskId);
      if (tasks.length === state.tasks.length) return state;
      const total = Math.max(0, state.total - 1);
      return {
        tasks,
        total,
        totalPages: Math.ceil(total / state.pageSize),
      };
    });
  },
}));

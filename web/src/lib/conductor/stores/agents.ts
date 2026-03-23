import { create } from 'zustand';
import type { Agent } from '../types';
import { ApiRequestError, getApiClient } from '../api/client';

export const AGENTS_POLL_INTERVAL_MS = 15_000;

type FetchAgentsOptions = {
  silent?: boolean;
};

interface AgentsState {
  agents: Agent[];
  isLoading: boolean;
  error: string | null;
  errorStatus: number | null;

  // Actions
  fetchAgents: (options?: FetchAgentsOptions) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  clearError: () => void;
}

let agentsPollTimer: ReturnType<typeof setInterval> | null = null;
let inFlightFetch: Promise<void> | null = null;

export const useAgentsStore = create<AgentsState>()((set) => ({
  agents: [],
  isLoading: false,
  error: null,
  errorStatus: null,

  fetchAgents: async (options = {}) => {
    if (inFlightFetch) {
      return inFlightFetch;
    }

    const { silent = false } = options;
    if (!silent) {
      set({ isLoading: true, error: null, errorStatus: null });
    }

    inFlightFetch = (async () => {
      try {
        const api = getApiClient();
        const agents = await api.get<Agent[]>('/agents');
        set((state) => ({
          agents,
          isLoading: silent ? state.isLoading : false,
          error: null,
          errorStatus: null,
        }));
      } catch (error) {
        set((state) => ({
          isLoading: silent ? state.isLoading : false,
          errorStatus: error instanceof ApiRequestError ? error.status : null,
          error: error instanceof Error ? error.message : 'Failed to fetch agents',
        }));
      } finally {
        inFlightFetch = null;
      }
    })();

    return inFlightFetch;
  },

  startPolling: () => {
    if (agentsPollTimer) {
      return;
    }
    agentsPollTimer = setInterval(() => {
      void useAgentsStore.getState().fetchAgents({ silent: true });
    }, AGENTS_POLL_INTERVAL_MS);
  },

  stopPolling: () => {
    if (!agentsPollTimer) {
      return;
    }
    clearInterval(agentsPollTimer);
    agentsPollTimer = null;
  },

  clearError: () => set({ error: null, errorStatus: null }),
}));

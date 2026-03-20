import { create } from 'zustand';
import type { Agent } from '../types';
import { ApiRequestError, getApiClient } from '../api/client';

interface AgentsState {
  agents: Agent[];
  isLoading: boolean;
  error: string | null;
  errorStatus: number | null;

  // Actions
  fetchAgents: () => Promise<void>;
  clearError: () => void;
}

export const useAgentsStore = create<AgentsState>()((set) => ({
  agents: [],
  isLoading: false,
  error: null,
  errorStatus: null,

  fetchAgents: async () => {
    set({ isLoading: true, error: null, errorStatus: null });
    try {
      const api = getApiClient();
      const agents = await api.get<Agent[]>('/agents');
      set({ agents, isLoading: false, errorStatus: null });
    } catch (error) {
      set({
        isLoading: false,
        errorStatus: error instanceof ApiRequestError ? error.status : null,
        error: error instanceof Error ? error.message : 'Failed to fetch agents',
      });
    }
  },

  clearError: () => set({ error: null, errorStatus: null }),
}));

import { create } from 'zustand';
import type { Agent } from '@/shared/types';
import { ApiRequestError, getApiClient } from '@/shared/api/client';

export const AGENTS_POLL_INTERVAL_MS = 15_000;

const pickString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const pickStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((entry): entry is string => typeof entry === 'string');
  return out.length > 0 ? out : undefined;
};

const pickStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

// Accept both camelCase and snake_case fields so a future API change that
// only emits one side cannot silently leave UI state undefined.
export const normalizeAgent = (raw: unknown): Agent | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record.id);
  const host = pickString(record.host);
  if (!id || !host) return null;

  return {
    id,
    host,
    supportedBackends:
      pickStringArray(record.supportedBackends) ?? pickStringArray(record.supported_backends),
    runtimeBackendMap:
      pickStringRecord(record.runtimeBackendMap) ?? pickStringRecord(record.runtime_backend_map),
    capabilities: pickStringArray(record.capabilities),
    version: pickString(record.version),
    shared: record.shared === true,
    ownerLabel: pickString(record.ownerLabel) ?? pickString(record.owner_label) ?? null,
  };
};

const normalizeAgentList = (raw: unknown): Agent[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeAgent(entry))
    .filter((agent): agent is Agent => agent !== null);
};

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
        const raw = await api.get<unknown>('/agents');
        const agents = normalizeAgentList(raw);
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

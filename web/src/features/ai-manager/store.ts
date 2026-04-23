import { create } from 'zustand';
import { ApiRequestError, getApiClient } from '@/shared/api/client';
import type {
  AccountsResponse,
  QuotaResponse,
  StatusResponse,
  SwitchResponse,
} from './types';

export const AI_MANAGER_POLL_INTERVAL_MS = 30_000;

interface PerHostState {
  status: StatusResponse | null;
  quota: QuotaResponse | null;
  accounts: AccountsResponse | null;
  loading: { status: boolean; quota: boolean; accounts: boolean; switching: boolean };
  error: { status?: string; quota?: string; accounts?: string; switching?: string };
}

interface AiManagerState {
  selectedHost: string | null;
  byHost: Record<string, PerHostState>;
  setSelectedHost(host: string | null): void;
  fetchStatus(host: string): Promise<void>;
  fetchQuota(host: string, opts?: { forceRefresh?: boolean }): Promise<void>;
  fetchAccounts(host: string): Promise<void>;
  fetchAll(host: string): Promise<void>;
  switchAccount(host: string, name: string): Promise<SwitchResponse | null>;
  startPolling(host: string): void;
  stopPolling(): void;
  reset(): void;
}

const emptyHostState = (): PerHostState => ({
  status: null,
  quota: null,
  accounts: null,
  loading: { status: false, quota: false, accounts: false, switching: false },
  error: {},
});

let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollHost: string | null = null;

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiRequestError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export const useAiManagerStore = create<AiManagerState>()((set, get) => ({
  selectedHost: null,
  byHost: {},

  setSelectedHost(host) {
    set({ selectedHost: host });
  },

  async fetchStatus(host) {
    const prev = get().byHost[host] ?? emptyHostState();
    set({ byHost: { ...get().byHost, [host]: { ...prev, loading: { ...prev.loading, status: true }, error: { ...prev.error, status: undefined } } } });
    try {
      const data = await getApiClient().get<StatusResponse>(
        `/ai-manager/status?agentHost=${encodeURIComponent(host)}`,
      );
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: { ...cur, status: data, loading: { ...cur.loading, status: false } },
        },
      });
    } catch (err) {
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: {
            ...cur,
            loading: { ...cur.loading, status: false },
            error: { ...cur.error, status: errorMessage(err, 'Failed to load status') },
          },
        },
      });
    }
  },

  async fetchQuota(host, opts = {}) {
    const prev = get().byHost[host] ?? emptyHostState();
    set({ byHost: { ...get().byHost, [host]: { ...prev, loading: { ...prev.loading, quota: true }, error: { ...prev.error, quota: undefined } } } });
    try {
      const params = new URLSearchParams({ agentHost: host });
      if (opts.forceRefresh) params.set('forceRefresh', '1');
      const data = await getApiClient().get<QuotaResponse>(`/ai-manager/quota?${params.toString()}`);
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: { ...cur, quota: data, loading: { ...cur.loading, quota: false } },
        },
      });
    } catch (err) {
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: {
            ...cur,
            loading: { ...cur.loading, quota: false },
            error: { ...cur.error, quota: errorMessage(err, 'Failed to load quota') },
          },
        },
      });
    }
  },

  async fetchAccounts(host) {
    const prev = get().byHost[host] ?? emptyHostState();
    set({ byHost: { ...get().byHost, [host]: { ...prev, loading: { ...prev.loading, accounts: true }, error: { ...prev.error, accounts: undefined } } } });
    try {
      const data = await getApiClient().get<AccountsResponse>(
        `/ai-manager/accounts?agentHost=${encodeURIComponent(host)}`,
      );
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: { ...cur, accounts: data, loading: { ...cur.loading, accounts: false } },
        },
      });
    } catch (err) {
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: {
            ...cur,
            loading: { ...cur.loading, accounts: false },
            error: { ...cur.error, accounts: errorMessage(err, 'Failed to load accounts') },
          },
        },
      });
    }
  },

  async fetchAll(host) {
    await Promise.all([get().fetchStatus(host), get().fetchQuota(host), get().fetchAccounts(host)]);
  },

  async switchAccount(host, name) {
    const prev = get().byHost[host] ?? emptyHostState();
    set({ byHost: { ...get().byHost, [host]: { ...prev, loading: { ...prev.loading, switching: true }, error: { ...prev.error, switching: undefined } } } });
    try {
      const data = await getApiClient().post<SwitchResponse>('/ai-manager/switch', {
        agentHost: host,
        name,
      });
      // refresh accounts + status + quota so the UI reflects the new current account.
      // Quota is force-refreshed because plan/limits change with the account.
      await Promise.all([
        get().fetchAccounts(host),
        get().fetchStatus(host),
        get().fetchQuota(host, { forceRefresh: true }),
      ]);
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: { ...cur, loading: { ...cur.loading, switching: false } },
        },
      });
      return data;
    } catch (err) {
      const cur = get().byHost[host] ?? emptyHostState();
      set({
        byHost: {
          ...get().byHost,
          [host]: {
            ...cur,
            loading: { ...cur.loading, switching: false },
            error: { ...cur.error, switching: errorMessage(err, 'Switch failed') },
          },
        },
      });
      return null;
    }
  },

  startPolling(host) {
    get().stopPolling();
    pollHost = host;
    pollTimer = setInterval(() => {
      void get().fetchQuota(host);
      void get().fetchStatus(host);
    }, AI_MANAGER_POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      pollHost = null;
    }
  },

  reset() {
    get().stopPolling();
    set({ selectedHost: null, byHost: {} });
  },
}));

export function activelyPollingHost(): string | null {
  return pollHost;
}

import { create } from 'zustand';
import { ApiRequestError, getApiClient } from '@/shared/api/client';
import type {
  AccountsResponse,
  CodexAccount,
  CodexQuota,
  QuotaResponse,
  StatusResponse,
  SwitchResponse,
} from './types';

export const AI_MANAGER_POLL_INTERVAL_MS = 30_000;

interface PerHostState {
  status: StatusResponse | null;
  quota: QuotaResponse | null;
  accounts: AccountsResponse | null;
  /**
   * Last-known codex quota per account name. Only the currently-active account's
   * quota is refreshed by polling; inactive accounts retain the snapshot they
   * had when they were last active, so the UI can show every configured
   * account's quota without issuing extra network calls.
   */
  codexQuotaByAccount: Record<string, CodexQuota>;
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
  codexQuotaByAccount: {},
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

/**
 * Map a freshly-fetched `CodexQuota` back to the account it belongs to. We try
 * the accounts list first (accountId → email) because those identity fields
 * come from the same auth.json the daemon just fetched against — making them
 * race-safe even if a switch happened in parallel. Only when neither is
 * present do we fall back to `status.currentCodexAccount`, and we refuse that
 * fallback for error payloads: error responses often omit identity fields, and
 * attributing the error to whichever account `status` currently points at
 * could mis-label a failure that belongs to a previously-active account.
 * Callers treat `undefined` as "could not confidently attribute" and surface
 * the error at the column level instead.
 */
export function resolveCodexAccountName(
  quota: CodexQuota | undefined,
  accounts: CodexAccount[] | undefined,
  status: StatusResponse | null,
): string | undefined {
  if (!quota) return undefined;
  const list = accounts ?? [];
  if (quota.accountId) {
    const hit = list.find((a) => a.accountId && a.accountId === quota.accountId);
    if (hit) return hit.name;
  }
  if (quota.email) {
    const hit = list.find((a) => a.email && a.email === quota.email);
    if (hit) return hit.name;
  }
  if (quota.error) return undefined;
  return status?.currentCodexAccount?.name;
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
      const accountName = resolveCodexAccountName(
        data.codex,
        cur.accounts?.accounts,
        cur.status,
      );
      const codexQuotaByAccount =
        accountName && data.codex
          ? { ...cur.codexQuotaByAccount, [accountName]: data.codex }
          : cur.codexQuotaByAccount;
      set({
        byHost: {
          ...get().byHost,
          [host]: {
            ...cur,
            quota: data,
            codexQuotaByAccount,
            loading: { ...cur.loading, quota: false },
          },
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
      // Seed per-account cached quotas from the daemon's on-disk snapshot.
      // This is what makes inactive-account quotas survive a page refresh:
      // the in-memory `codexQuotaByAccount` map is empty on first load, but
      // the daemon already knows every account's last-fetched quota. We only
      // seed entries that aren't already present in memory — the live poll's
      // fresh data always wins over the disk snapshot.
      const codexQuotaByAccount = { ...cur.codexQuotaByAccount };
      for (const acct of data.accounts) {
        if (acct.cachedQuota && !codexQuotaByAccount[acct.name]) {
          codexQuotaByAccount[acct.name] = acct.cachedQuota;
        }
      }
      set({
        byHost: {
          ...get().byHost,
          [host]: {
            ...cur,
            accounts: data,
            codexQuotaByAccount,
            loading: { ...cur.loading, accounts: false },
          },
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
      // Refresh accounts + status so the new current account is visible
      // immediately. Kick off a fresh quota fetch in the background — we keep
      // the post-switch quota call non-blocking so the "Switching…" dialog
      // dismisses right after auth.json is rewritten; the bars will animate in
      // once fetchQuota resolves (its own loading.quota flag covers that UI).
      await Promise.all([get().fetchAccounts(host), get().fetchStatus(host)]);
      void get().fetchQuota(host, { forceRefresh: true });
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
      // Refresh accounts too: when the user edits `ai_manager.codex.auth_json`
      // in ~/.conductor/config.yaml on the daemon machine, the new entries
      // should surface without waiting for a manual page refresh. This is a
      // local fs read on the daemon, so the cost is negligible.
      void get().fetchAccounts(host);
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

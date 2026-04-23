import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCodexAccountName, useAiManagerStore } from './store';
import type {
  AccountsResponse,
  CodexAccount,
  CodexQuota,
  StatusResponse,
} from './types';

const apiGetMock = vi.fn();

vi.mock('@/shared/api/client', () => ({
  ApiRequestError: class MockApiRequestError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = status;
    }
  },
  getApiClient: () => ({
    get: apiGetMock,
    post: vi.fn(),
  }),
}));

function makeAccount(overrides: Partial<CodexAccount> = {}): CodexAccount {
  return {
    name: 'acct',
    path: '/etc/acct.json',
    isCurrent: false,
    ...overrides,
  };
}

function makeQuota(overrides: Partial<CodexQuota> = {}): CodexQuota {
  return {
    tool: 'codex',
    source: 'fresh',
    fiveHour: { usedPercent: 0, remainingPercent: 100 },
    weekly: { usedPercent: 0, remainingPercent: 100 },
    ...overrides,
  };
}

function makeStatus(currentName: string | null): StatusResponse {
  return {
    install: {
      codex: { installed: true },
      claude: { installed: false },
      kimi: { installed: false },
      copilot: { installed: false },
    },
    network: {
      codex: { reachable: true, endpoint: '' },
      claude: { reachable: false, endpoint: '' },
      kimi: { reachable: false, endpoint: '' },
      copilot: { reachable: false, endpoint: '' },
    },
    currentCodexAccount: currentName
      ? makeAccount({ name: currentName, isCurrent: true })
      : null,
  };
}

describe('resolveCodexAccountName', () => {
  const alice = makeAccount({
    name: 'alice',
    email: 'alice@example.com',
    accountId: 'acc-alice',
    isCurrent: true,
  });
  const bob = makeAccount({
    name: 'bob',
    email: 'bob@example.com',
    accountId: 'acc-bob',
  });

  it('prefers accountId match over status fallback (race-safe)', () => {
    // Quota payload is Bob's even though status still points at Alice — this
    // is the poll-then-switch race. accountId match must win.
    const quota = makeQuota({ accountId: 'acc-bob', email: 'bob@example.com' });
    expect(
      resolveCodexAccountName(quota, [alice, bob], makeStatus('alice')),
    ).toBe('bob');
  });

  it('falls back to email match when accountId is missing', () => {
    const quota = makeQuota({ email: 'bob@example.com' });
    expect(
      resolveCodexAccountName(quota, [alice, bob], makeStatus('alice')),
    ).toBe('bob');
  });

  it('falls back to status.currentCodexAccount when both identity fields are missing and no error', () => {
    const quota = makeQuota({});
    expect(
      resolveCodexAccountName(quota, [alice, bob], makeStatus('alice')),
    ).toBe('alice');
  });

  it('refuses status fallback when the quota carries an error (prevents mis-attribution)', () => {
    // Regression guard for L1/M1 in code review: an error payload without
    // identity fields should NOT be attributed to whichever account status
    // currently points at — that would hide the real failure on a previous
    // account after a switch.
    const quota = makeQuota({ error: 'auth failed' });
    expect(
      resolveCodexAccountName(quota, [alice, bob], makeStatus('alice')),
    ).toBeUndefined();
  });

  it('still keys an error payload when it carries an accountId', () => {
    const quota = makeQuota({ accountId: 'acc-bob', error: 'rate limited' });
    expect(
      resolveCodexAccountName(quota, [alice, bob], makeStatus('alice')),
    ).toBe('bob');
  });

  it('returns undefined for an undefined quota', () => {
    expect(
      resolveCodexAccountName(undefined, [alice, bob], makeStatus('alice')),
    ).toBeUndefined();
  });

  it('handles missing accounts list and missing status', () => {
    const quota = makeQuota({ email: 'ghost@example.com' });
    expect(resolveCodexAccountName(quota, undefined, null)).toBeUndefined();
  });
});

describe('fetchAccounts seeds codexQuotaByAccount from daemon cache', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
    useAiManagerStore.setState({ selectedHost: null, byHost: {} });
  });

  it('restores inactive-account quota snapshots on page refresh', async () => {
    // This simulates what happens on page load: the store is empty, the
    // daemon already has on-disk caches for each account, and `list_accounts`
    // surfaces them via `cachedQuota`. The store should seed
    // codexQuotaByAccount so the UI can render inactive accounts' bars
    // immediately — without waiting for each to become active.
    const aliceCache = makeQuota({
      accountId: 'acc-alice',
      email: 'alice@example.com',
      source: 'cached',
      plan: 'PLUS',
      fiveHour: { usedPercent: 42, remainingPercent: 58 },
    });
    const bobCache = makeQuota({
      accountId: 'acc-bob',
      email: 'bob@example.com',
      source: 'cached',
      plan: 'PRO',
      weekly: { usedPercent: 20, remainingPercent: 80 },
    });
    const payload: AccountsResponse = {
      accounts: [
        makeAccount({
          name: 'alice',
          email: 'alice@example.com',
          accountId: 'acc-alice',
          isCurrent: true,
          cachedQuota: aliceCache,
        }),
        makeAccount({
          name: 'bob',
          email: 'bob@example.com',
          accountId: 'acc-bob',
          isCurrent: false,
          cachedQuota: bobCache,
        }),
      ],
    };
    apiGetMock.mockResolvedValueOnce(payload);

    await useAiManagerStore.getState().fetchAccounts('daemon-a');

    const state = useAiManagerStore.getState().byHost['daemon-a'];
    expect(state.codexQuotaByAccount.alice?.plan).toBe('PLUS');
    expect(state.codexQuotaByAccount.alice?.fiveHour.usedPercent).toBe(42);
    expect(state.codexQuotaByAccount.bob?.plan).toBe('PRO');
    expect(state.codexQuotaByAccount.bob?.weekly.remainingPercent).toBe(80);
  });

  it('does not overwrite a live-refreshed in-memory entry with a stale cache', async () => {
    // Guard: if the user has already seen a fresh poll-update for an account,
    // a subsequent fetchAccounts should NOT clobber that fresher in-memory
    // snapshot with whatever the daemon happens to have on disk. The in-memory
    // value wins; the cache only fills holes.
    useAiManagerStore.setState({
      byHost: {
        'daemon-a': {
          status: null,
          quota: null,
          accounts: null,
          codexQuotaByAccount: {
            alice: makeQuota({
              plan: 'LIVE',
              source: 'fresh',
              fiveHour: { usedPercent: 99, remainingPercent: 1 },
            }),
          },
          loading: { status: false, quota: false, accounts: false, switching: false },
          error: {},
        },
      },
    });
    apiGetMock.mockResolvedValueOnce({
      accounts: [
        makeAccount({
          name: 'alice',
          cachedQuota: makeQuota({ plan: 'STALE', source: 'cached' }),
        }),
      ],
    });

    await useAiManagerStore.getState().fetchAccounts('daemon-a');

    const state = useAiManagerStore.getState().byHost['daemon-a'];
    expect(state.codexQuotaByAccount.alice?.plan).toBe('LIVE');
    expect(state.codexQuotaByAccount.alice?.fiveHour.usedPercent).toBe(99);
  });
});

import { describe, expect, it } from 'vitest';
import { resolveCodexAccountName } from './store';
import type { CodexAccount, CodexQuota, StatusResponse } from './types';

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

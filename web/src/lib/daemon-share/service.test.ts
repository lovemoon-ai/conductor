import { describe, expect, it } from 'vitest';
import {
  buildDaemonShareInviteUrl,
  buildGuestHost,
  DAEMON_SHARE_INVITE_TTL_MS,
  disambiguateGuestHost,
  FIRE_HOST_PREFIX,
  formatUserLabel,
  inviteExpiresAt,
  isHostAllowedForShare,
  isInviteExpired,
  liveShareWhere,
  sanitizeHostPart,
} from './service';

describe('buildGuestHost', () => {
  it('produces a host that survives fire-host sanitization unchanged', () => {
    // The regression this guards: an earlier draft used `alice@mbp`. Fire hosts
    // are `conductor-fire-<sanitizeHostSegment(daemonName)>-<taskId>`, and that
    // sanitizer maps anything outside [A-Za-z0-9._-] to `-`, so `a@b` and `a-b`
    // would collapse to the same fire identity -- which the outbox and the
    // attachment token signer both key on.
    const host = buildGuestHost('alice', 'alice-mbp');
    expect(host).toBe('shared-alice-alice-mbp');
    expect(sanitizeHostPart(host)).toBe(host);
  });

  it('strips characters that would not survive sanitization', () => {
    const host = buildGuestHost('ali ce@corp', 'mbp/1');
    expect(host).toMatch(/^[A-Za-z0-9._-]+$/);
    expect(sanitizeHostPart(host)).toBe(host);
  });

  it('never yields something the backend would route as a fire host', () => {
    const host = buildGuestHost('conductor-fire', 'x');
    expect(host.startsWith(`${FIRE_HOST_PREFIX}`)).toBe(false);
  });

  it('falls back when both parts sanitize to nothing', () => {
    expect(buildGuestHost('!!!', '???')).toBe('shared-owner-daemon');
  });
});

describe('disambiguateGuestHost', () => {
  it('returns the base name when free', () => {
    expect(disambiguateGuestHost('shared-a-b', new Set())).toBe('shared-a-b');
  });

  it('suffixes past taken names', () => {
    const taken = new Set(['shared-a-b', 'shared-a-b-2']);
    expect(disambiguateGuestHost('shared-a-b', taken)).toBe('shared-a-b-3');
  });
});

describe('isHostAllowedForShare', () => {
  const guestHost = 'shared-alice-alice-mbp';

  it('accepts the guest host itself', () => {
    expect(isHostAllowedForShare(guestHost, guestHost)).toBe(true);
  });

  it('accepts fire hosts derived from the guest host', () => {
    // A fire launched by the guest inherits the guest token and connects as a
    // separate agent. Rejecting it would let a shared daemon start tasks but
    // never report results.
    expect(
      isHostAllowedForShare(`${FIRE_HOST_PREFIX}${guestHost}-task-123`, guestHost),
    ).toBe(true);
  });

  it('rejects another daemon of the same user', () => {
    expect(isHostAllowedForShare('MacBook-Pro.local', guestHost)).toBe(false);
  });

  it('rejects a fire host belonging to a different daemon', () => {
    expect(
      isHostAllowedForShare(`${FIRE_HOST_PREFIX}someone-else-task-1`, guestHost),
    ).toBe(false);
  });

  it('rejects empty and whitespace hosts', () => {
    expect(isHostAllowedForShare('', guestHost)).toBe(false);
    expect(isHostAllowedForShare('   ', guestHost)).toBe(false);
  });
});

describe('formatUserLabel', () => {
  it('never returns a full email address', () => {
    // Anyone holding an invite link can read the invitation endpoint, so the
    // label must not be a contact detail.
    expect(formatUserLabel({ id: 'u1', email: 'alice@example.com' })).toBe('alice');
  });

  it('masks phone numbers', () => {
    expect(formatUserLabel({ id: 'u1', phone: '+8613800001234' })).toBe('***1234');
  });

  it('falls back to a truncated id', () => {
    expect(formatUserLabel({ id: 'abcdef0123456789' })).toBe('User abcdef01');
  });
});

describe('buildDaemonShareInviteUrl', () => {
  it('prefers the configured origin over the request host', () => {
    const previous = process.env.NEXT_PUBLIC_BASE_URL;
    process.env.NEXT_PUBLIC_BASE_URL = 'https://app.example.com';
    try {
      expect(
        buildDaemonShareInviteUrl({ url: 'https://attacker.example/api/x' }, 'tok'),
      ).toBe('https://app.example.com/app/daemon-share/tok');
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
      else process.env.NEXT_PUBLIC_BASE_URL = previous;
    }
  });
});

describe('invite expiry', () => {
  const NOW = new Date('2026-08-31T12:00:00.000Z');

  it('mints a five-minute deadline', () => {
    expect(inviteExpiresAt(NOW).toISOString()).toBe('2026-08-31T12:05:00.000Z');
    expect(DAEMON_SHARE_INVITE_TTL_MS).toBe(5 * 60_000);
  });

  it('keeps a pending invite alive until its deadline', () => {
    const share = { status: 'pending', expiresAt: new Date(NOW.getTime() + 1000) };
    expect(isInviteExpired(share, NOW)).toBe(false);
  });

  it('expires a pending invite once the deadline passes', () => {
    const share = { status: 'pending', expiresAt: new Date(NOW.getTime() - 1) };
    expect(isInviteExpired(share, NOW)).toBe(true);
  });

  it('treats a pending invite with no deadline as expired', () => {
    // Rows written before expiry existed. Reading NULL as "never expires"
    // would leave exactly the forever-valid links this change exists to kill.
    expect(isInviteExpired({ status: 'pending', expiresAt: null }, NOW)).toBe(true);
  });

  it('never expires a share that was already accepted', () => {
    // The deadline governs the invite link, not the access it grants. An
    // active share ends by revocation only.
    expect(isInviteExpired({ status: 'active', expiresAt: null }, NOW)).toBe(false);
    expect(
      isInviteExpired({ status: 'active', expiresAt: new Date(NOW.getTime() - 9e6) }, NOW),
    ).toBe(false);
  });

  it('builds a where-fragment that admits active and unexpired pending only', () => {
    // Guards the one definition every caller shares. `gt` against NULL is
    // false in SQL, which is what makes legacy rows fail closed.
    expect(liveShareWhere(NOW)).toEqual({
      OR: [
        { status: 'active' },
        { status: 'pending', expiresAt: { gt: NOW } },
      ],
    });
  });
});

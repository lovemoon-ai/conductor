import { describe, expect, it } from 'vitest';
import {
  FIRE_HOST_PREFIX,
  buildDaemonShareInviteUrl,
  buildGuestHost,
  disambiguateGuestHost,
  formatUserLabel,
  isHostAllowedForShare,
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

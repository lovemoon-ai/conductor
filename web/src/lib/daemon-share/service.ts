import { randomBytes } from 'crypto';

/**
 * RFC 0035 — Daemon Sharing.
 *
 * A share grants "user B may use user A's daemon". The guest daemon process
 * runs on A's machine but authenticates as B, so B's tasks are ordinary rows
 * under B's own projects and every existing ownership check keeps working
 * unchanged. That is the whole reason this design touches so little: the
 * backend never learns about sharing on the hot path.
 */

/**
 * One process per guest, so this bounds memory on the owner's machine rather
 * than expressing a product limit. Counts `pending` too — an unaccepted invite
 * is a reserved slot, otherwise handing out ten links lets ten people race for
 * three slots and seven get a confusing failure at accept time.
 */
export const MAX_SHARES_PER_DAEMON = 3;

export const createShareInviteToken = (): string => randomBytes(32).toString('base64url');

/**
 * How long an unaccepted invite link stays redeemable.
 *
 * Short on purpose. The token is unguessable, so the risk this bounds is not
 * brute force but exposure over time: a link pasted into the wrong window or
 * left in a chat log, redeemed later by whoever finds it, yielding a shell on
 * the owner's machine and their signed-in AI accounts. Five minutes covers
 * "create it, send it, they click it" and nothing else.
 */
export const DAEMON_SHARE_INVITE_TTL_MS = 5 * 60_000;

export const inviteExpiresAt = (now: Date = new Date()): Date =>
  new Date(now.getTime() + DAEMON_SHARE_INVITE_TTL_MS);

/**
 * The single definition of "this share still counts".
 *
 * Every caller — the list, the per-daemon cap, the invite lookup, the accept
 * claim — must agree on it. Two layers evaluating expiry slightly differently
 * is how a check becomes decorative, so there is exactly one expression of it
 * and it is a Prisma `where` fragment rather than a predicate over loaded rows,
 * so the database does the filtering and the accept path can use it atomically.
 *
 * A pending row with a NULL `expiresAt` predates this rule. `gt` is false
 * against NULL, so it is excluded — fail closed.
 */
export const liveShareWhere = (now: Date = new Date()) => ({
  OR: [
    { status: 'active' },
    { status: 'pending', expiresAt: { gt: now } },
  ],
});

/** True when a share row can no longer be redeemed because its link aged out. */
export const isInviteExpired = (
  share: { status: string; expiresAt: Date | null },
  now: Date = new Date(),
): boolean => share.status === 'pending' && !(share.expiresAt && share.expiresAt > now);

export const INVITE_EXPIRED_MESSAGE =
  'This invite link has expired. Ask for a new one.';

export type DaemonShareStatus = 'pending' | 'active' | 'revoked';

type UserIdentity = {
  id: string;
  email?: string | null;
  phone?: string | null;
};

/**
 * Never expose raw email/phone in share responses. Anyone holding an invite
 * link can read the invitation endpoint, so echoing contact details there would
 * turn a share link into a directory lookup. RFC 0026 shipped this same bug
 * once; the lesson is recorded in its "Lessons Already Captured" section.
 */
export const formatUserLabel = (user: UserIdentity): string => {
  const email = user.email?.trim();
  if (email) {
    const [local] = email.split('@');
    return local || email;
  }
  const phone = user.phone?.trim();
  if (phone) {
    return `***${phone.slice(-4)}`;
  }
  return `User ${user.id.slice(0, 8)}`;
};

const normalizeBaseUrl = (value: string | undefined | null): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

/**
 * Mirrors `collaboration/service.ts#buildInviteUrl`: configured origin first,
 * request URL only as a local-dev fallback. Trusting `request.url` when a proxy
 * forgets to strip `X-Forwarded-Host` would let an attacker get a phishing
 * origin embedded next to a real invite token.
 */
export const buildDaemonShareInviteUrl = (
  request: { url: string },
  inviteToken: string,
): string => {
  const configured =
    normalizeBaseUrl(process.env.NEXT_PUBLIC_BASE_URL) ??
    normalizeBaseUrl(process.env.NEXT_PUBLIC_URL);
  const base = configured ?? request.url;
  return new URL(`/app/daemon-share/${encodeURIComponent(inviteToken)}`, base).toString();
};

/**
 * Host segments are restricted to `[A-Za-z0-9._-]` because a fire process
 * derives its own WebSocket identity as
 * `conductor-fire-<sanitizeHostSegment(daemonName)>-<taskId>`
 * (`modules/conductor-sdk/src/agent-host.ts`). That sanitizer rewrites anything
 * outside the set to `-`, and the resulting fire host is load-bearing: the
 * outbox pins undelivered commands to it and attachment transfer tokens are
 * signed against it. A separator that does not survive sanitization (`@` was
 * the first draft) would let two distinct guest hosts collapse into one fire
 * identity.
 */
const HOST_SAFE = /[^A-Za-z0-9._-]+/g;

export const sanitizeHostPart = (value: string): string =>
  value.trim().replace(HOST_SAFE, '-').replace(/^[-.]+|[-.]+$/g, '');

export const FIRE_HOST_PREFIX = 'conductor-fire-';

/**
 * The name the grantee sees for the borrowed machine. The `shared-` prefix is
 * UX, not correctness: the realtime hub keys agent connections by
 * `(userId, host)`, so two accounts may legitimately hold the same host name
 * (verified experimentally). The prefix exists so the grantee can tell at a
 * glance that the filesystem underneath is not theirs.
 */
export const buildGuestHost = (ownerLabel: string, ownerDaemonHost: string): string => {
  const owner = sanitizeHostPart(ownerLabel) || 'owner';
  const host = sanitizeHostPart(ownerDaemonHost) || 'daemon';
  const candidate = `shared-${owner}-${host}`.slice(0, 100);
  // Must never look like a fire host or the backend will route it as one.
  return candidate.startsWith(FIRE_HOST_PREFIX) ? `shared-${candidate}` : candidate;
};

/**
 * `@@unique([granteeUserId, guestHost])` is the real guard; this only picks a
 * name that is likely to be free so the common case avoids a retry.
 */
export const disambiguateGuestHost = (base: string, taken: Set<string>): string => {
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
};

export type SerializedDaemonShare = {
  id: string;
  ownerDaemonHost: string;
  guestHost: string | null;
  status: DaemonShareStatus;
  workspaceRoot: string | null;
  granteeLabel: string | null;
  ownerLabel: string | null;
  createdAt: string;
  /** Deadline for redeeming an unaccepted invite link; null once accepted. */
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
};

type ShareRow = {
  id: string;
  ownerDaemonHost: string;
  guestHost: string | null;
  status: string;
  workspaceRoot: string | null;
  createdAt: Date;
  expiresAt?: Date | null;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  owner?: UserIdentity | null;
  grantee?: UserIdentity | null;
};

export const serializeDaemonShare = (share: ShareRow): SerializedDaemonShare => ({
  id: share.id,
  ownerDaemonHost: share.ownerDaemonHost,
  guestHost: share.guestHost,
  status: share.status as DaemonShareStatus,
  workspaceRoot: share.workspaceRoot,
  granteeLabel: share.grantee ? formatUserLabel(share.grantee) : null,
  ownerLabel: share.owner ? formatUserLabel(share.owner) : null,
  createdAt: share.createdAt.toISOString(),
  expiresAt: share.expiresAt?.toISOString() ?? null,
  acceptedAt: share.acceptedAt?.toISOString() ?? null,
  revokedAt: share.revokedAt?.toISOString() ?? null,
});

export class DaemonShareCapExceededError extends Error {
  constructor() {
    super(`A daemon can be shared with at most ${MAX_SHARES_PER_DAEMON} people`);
    this.name = 'DaemonShareCapExceededError';
  }
}

/**
 * Hosts a share may legitimately connect as: the guest daemon itself, plus any
 * fire process it launches. Fire inherits the guest's token and connects as a
 * *separate* agent connection under a derived host, so a host check that only
 * accepts `guestHost` would let shared daemons start tasks but never report
 * results back.
 */
export const isHostAllowedForShare = (host: string, guestHost: string): boolean => {
  const trimmed = host.trim();
  if (!trimmed) return false;
  if (trimmed === guestHost) return true;
  return trimmed.startsWith(`${FIRE_HOST_PREFIX}${sanitizeHostPart(guestHost)}-`);
};

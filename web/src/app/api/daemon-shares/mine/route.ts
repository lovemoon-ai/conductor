import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import { formatUserLabel } from '@/lib/daemon-share/service';

/**
 * Called by the OWNER's daemon (with the owner's own full token) to learn which
 * guest daemons it should be running.
 *
 * This is the only endpoint that returns the grantee's scoped token in
 * plaintext, and it is safe precisely because of who is asking: the owner is
 * already authenticated on their own channel, and the token is going to a
 * process on the owner's machine either way. It never passes through the
 * grantee's browser.
 *
 * A `daemon_share`-scoped token must not reach this route — a guest daemon
 * asking "what should I run?" would be handed its siblings' credentials. The
 * scope allowlist in `getAuthUser` is what enforces that; this route stays
 * simple on purpose.
 */
export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const daemonHost = request.nextUrl.searchParams.get('daemonHost')?.trim();

  const shares = await db.daemonShare.findMany({
    where: {
      ownerUserId: user.id,
      status: 'active',
      ...(daemonHost ? { ownerDaemonHost: daemonHost } : {}),
    },
    select: {
      id: true,
      ownerDaemonHost: true,
      guestHost: true,
      workspaceRoot: true,
      status: true,
      agentToken: true,
      grantee: { select: { id: true, email: true, phone: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    shares: shares
      // A share with no token or host is not launchable. Skipping is the
      // non-permissive choice: better the supervisor starts nothing than a
      // guest with a half-built identity.
      .filter((share) => share.agentToken && share.guestHost)
      .map((share) => ({
        id: share.id,
        guestHost: share.guestHost,
        ownerDaemonHost: share.ownerDaemonHost,
        workspaceRoot: share.workspaceRoot,
        status: share.status,
        granteeLabel: share.grantee ? formatUserLabel(share.grantee) : null,
        agentToken: share.agentToken,
      })),
  });
}

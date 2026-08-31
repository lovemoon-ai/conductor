import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime/hub';
import { isConductorFireHost } from '@/lib/subscription/plan-limits';
import {
  DaemonShareCapExceededError,
  MAX_SHARES_PER_DAEMON,
  buildDaemonShareInviteUrl,
  createShareInviteToken,
  inviteExpiresAt,
  liveShareWhere,
  serializeDaemonShare,
} from '@/lib/daemon-share/service';

const shareSelect = {
  id: true,
  ownerDaemonHost: true,
  guestHost: true,
  status: true,
  workspaceRoot: true,
  createdAt: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  inviteToken: true,
  grantee: { select: { id: true, email: true, phone: true } },
} satisfies Prisma.DaemonShareSelect;

/** List the shares this user owns (optionally for one daemon). */
export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const daemonHost = request.nextUrl.searchParams.get('daemonHost')?.trim();
  const shares = await db.daemonShare.findMany({
    where: {
      ownerUserId: user.id,
      // Not `status != revoked`: an expired invite grants nothing, so listing
      // it as "Invite not accepted yet" would claim access exists that does
      // not. It also must not keep occupying one of the three slots.
      ...liveShareWhere(),
      ...(daemonHost ? { ownerDaemonHost: daemonHost } : {}),
    },
    select: shareSelect,
    orderBy: { createdAt: 'asc' },
  });

  return NextResponse.json({
    shares: shares.map((share) => ({
      ...serializeDaemonShare(share),
      inviteUrl: buildDaemonShareInviteUrl(request, share.inviteToken),
    })),
    maxSharesPerDaemon: MAX_SHARES_PER_DAEMON,
  });
}

/** Create an invite for one of the caller's own online daemons. */
export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  let body: { daemonHost?: unknown; workspaceRoot?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const daemonHost = typeof body.daemonHost === 'string' ? body.daemonHost.trim() : '';
  const workspaceRoot =
    typeof body.workspaceRoot === 'string' && body.workspaceRoot.trim()
      ? body.workspaceRoot.trim()
      : null;

  if (!daemonHost) {
    return NextResponse.json({ error: 'daemonHost is required' }, { status: 400 });
  }
  // A fire host is a single task's process, not a machine. Sharing one would
  // create a guest bound to something that disappears when the task ends.
  if (isConductorFireHost(daemonHost)) {
    return NextResponse.json({ error: 'Cannot share a fire host' }, { status: 400 });
  }
  // Requiring the daemon to be online is what proves the caller actually owns
  // it: `getAgentsForUser` is scoped to this user's live connections, and
  // `daemonHost` is otherwise just a string the client asserted.
  if (!realtimeHub.hasAgentHost(daemonHost, user.id)) {
    return NextResponse.json(
      { error: `Daemon ${daemonHost} is offline` },
      { status: 409 },
    );
  }

  try {
    const share = await db.$transaction(
      async (tx) => {
        const created = await tx.daemonShare.create({
          data: {
            ownerUserId: user.id,
            ownerDaemonHost: daemonHost,
            workspaceRoot,
            inviteToken: createShareInviteToken(),
            status: 'pending',
            expiresAt: inviteExpiresAt(),
          },
          select: shareSelect,
        });

        // Insert-then-count rather than count-then-insert: two concurrent
        // creates both reading "2 of 3 used" would each decide there is room.
        // Counting after our own row exists means at least one of them sees
        // the overflow and rolls back. Same pattern as collaboration/join.
        const used = await tx.daemonShare.count({
          where: {
            ownerUserId: user.id,
            ownerDaemonHost: daemonHost,
            // Same predicate as the list. Counting expired invites here would
            // let three abandoned links lock a machine out of sharing forever.
            ...liveShareWhere(),
          },
        });
        if (used > MAX_SHARES_PER_DAEMON) {
          throw new DaemonShareCapExceededError();
        }
        return created;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    const inviteUrl = buildDaemonShareInviteUrl(request, share.inviteToken);
    return NextResponse.json(
      { ...serializeDaemonShare(share), inviteToken: share.inviteToken, inviteUrl },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DaemonShareCapExceededError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2034'
    ) {
      return NextResponse.json(
        { error: 'Share creation conflicted, please retry' },
        { status: 409 },
      );
    }
    throw error;
  }
}

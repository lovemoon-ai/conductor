import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import { realtimeHub } from '@/lib/realtime/hub';
import { isHostAllowedForShare } from '@/lib/daemon-share/service';

/**
 * Revoke a share. Either side may do it: the owner reclaims their machine, the
 * grantee walks away.
 *
 * Revocation has to be complete or it leaves a half-dead guest behind, so this
 * does four things and all four matter:
 *   1. mark the share revoked and drop the stored plaintext
 *   2. revoke the scoped credential
 *   3. drain the guest's outbox — otherwise commands queue forever against a
 *      daemon that will never reconnect, and eventually land in the DLQ
 *   4. close the live connection so an already-running guest stops immediately
 *      rather than at its next token check
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const { id } = await params;

  const share = await db.daemonShare.findUnique({
    where: { id },
    select: {
      id: true,
      ownerUserId: true,
      granteeUserId: true,
      guestHost: true,
      tokenId: true,
      status: true,
    },
  });

  if (!share) {
    return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  }
  if (share.ownerUserId !== user.id && share.granteeUserId !== user.id) {
    return NextResponse.json({ error: 'Share not found' }, { status: 404 });
  }
  if (share.status === 'revoked') {
    return NextResponse.json({ ok: true, alreadyRevoked: true });
  }

  await db.daemonShare.update({
    where: { id: share.id },
    data: { status: 'revoked', revokedAt: new Date(), agentToken: null },
  });

  if (share.tokenId) {
    await db.userToken.updateMany({
      where: { id: share.tokenId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  if (share.granteeUserId && share.guestHost) {
    // The guest daemon is not the only connection this credential holds. Every
    // fire it launched connects separately as `conductor-fire-<guestHost>-<task>`
    // with the same token, and closing only the daemon leaves those alive --
    // verified live: after revoking, the daemon socket dropped in the same
    // second while a fire socket stayed connected indefinitely.
    const revokedHosts = realtimeHub
      .getAgentsForUser(share.granteeUserId)
      .map((agent) => agent.host)
      .filter((host) => isHostAllowedForShare(host, share.guestHost as string));
    // The guest host itself may be offline right now and so absent from the
    // live list; include it so its queued commands are still cleared.
    if (!revokedHosts.includes(share.guestHost)) revokedHosts.push(share.guestHost);

    await db.agentOutbox.deleteMany({
      where: {
        userId: share.granteeUserId,
        agentHost: { in: revokedHosts },
        status: { in: ['pending', 'sent'] },
      },
    });
    for (const host of revokedHosts) {
      // Named "takeOver" because its normal use is a reconnect replacing a
      // stale socket; here we just want the old one gone.
      realtimeHub.takeOverAgentHost(host, share.granteeUserId);
    }
  }

  return NextResponse.json({ ok: true });
}

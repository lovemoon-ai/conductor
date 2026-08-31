import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import { issueApiToken } from '@/lib/auth/service';
import {
  buildGuestHost,
  disambiguateGuestHost,
  formatUserLabel,
  serializeDaemonShare,
} from '@/lib/daemon-share/service';

/**
 * Accept a daemon share.
 *
 * Mints a `daemon_share`-scoped token that authenticates as the *grantee* but
 * will live on the *owner's* disk. The plaintext is stashed on the share row so
 * `GET /api/daemon-shares/mine` can hand it to the owner's daemon over the
 * owner's own authenticated channel — it never travels through the grantee's
 * browser or any out-of-band path.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const { token } = await params;

  const share = await db.daemonShare.findUnique({
    where: { inviteToken: token },
    select: {
      id: true,
      ownerUserId: true,
      ownerDaemonHost: true,
      status: true,
      owner: { select: { id: true, email: true, phone: true } },
    },
  });

  if (!share || share.status === 'revoked') {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }
  if (share.status !== 'pending') {
    return NextResponse.json({ error: 'Invitation already accepted' }, { status: 409 });
  }
  if (share.ownerUserId === user.id) {
    return NextResponse.json(
      { error: 'Cannot accept your own daemon share' },
      { status: 400 },
    );
  }

  const existingHosts = await db.daemonShare.findMany({
    where: { granteeUserId: user.id, guestHost: { not: null } },
    select: { guestHost: true },
  });
  const guestHost = disambiguateGuestHost(
    buildGuestHost(formatUserLabel(share.owner), share.ownerDaemonHost),
    new Set(existingHosts.map((row) => row.guestHost).filter((h): h is string => !!h)),
  );

  // Minted before the transaction because `issueApiToken` writes its own row;
  // if the claim below loses a race we revoke it rather than leaving a live
  // credential attached to nothing.
  const minted = await issueApiToken(user.id, `daemon-share:${share.id}`, 'daemon_share');

  try {
    const claimed = await db.daemonShare.updateMany({
      // `status: 'pending'` in the filter is the concurrency guard: two
      // simultaneous accepts both pass the read above, but only one updateMany
      // matches a row, so the loser gets count 0 and its token is revoked.
      where: { id: share.id, status: 'pending' },
      data: {
        granteeUserId: user.id,
        guestHost,
        status: 'active',
        acceptedAt: new Date(),
        tokenId: minted.tokenId,
        agentToken: minted.token,
      },
    });

    if (claimed.count === 0) {
      await db.userToken.update({
        where: { id: minted.tokenId },
        data: { revokedAt: new Date() },
      });
      return NextResponse.json({ error: 'Invitation already accepted' }, { status: 409 });
    }

    await db.userToken.update({
      where: { id: minted.tokenId },
      data: { daemonShareId: share.id },
    });
  } catch (error) {
    await db.userToken
      .update({ where: { id: minted.tokenId }, data: { revokedAt: new Date() } })
      .catch(() => {});
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return NextResponse.json(
        { error: 'Guest host already in use, please retry' },
        { status: 409 },
      );
    }
    throw error;
  }

  const updated = await db.daemonShare.findUniqueOrThrow({
    where: { id: share.id },
    select: {
      id: true,
      ownerDaemonHost: true,
      guestHost: true,
      status: true,
      workspaceRoot: true,
      createdAt: true,
      acceptedAt: true,
      revokedAt: true,
      owner: { select: { id: true, email: true, phone: true } },
    },
  });

  return NextResponse.json(serializeDaemonShare(updated));
}

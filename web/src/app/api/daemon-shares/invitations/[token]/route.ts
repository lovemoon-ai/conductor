import { NextRequest, NextResponse } from 'next/server';
import { getActiveSubscriptionUser } from '@/lib/auth/middleware';
import { db } from '@/lib/db';
import {
  INVITE_EXPIRED_MESSAGE,
  formatUserLabel,
  isInviteExpired,
} from '@/lib/daemon-share/service';

/**
 * Invite landing page data.
 *
 * Login is required so a leaked link cannot be probed anonymously, and the
 * response deliberately carries only `ownerLabel` — never raw email/phone.
 * Anyone holding the link can call this, so echoing contact details would turn
 * a share link into a directory lookup.
 */
export async function GET(
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
      granteeUserId: true,
      guestHost: true,
      status: true,
      expiresAt: true,
      workspaceRoot: true,
      owner: { select: { id: true, email: true, phone: true } },
    },
  });

  if (!share || share.status === 'revoked') {
    return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
  }
  // Distinguished from "not found" on purpose: the holder of an expired link
  // already knows the invite existed, so hiding the reason only leaves them
  // guessing whether they mistyped the URL.
  if (isInviteExpired(share)) {
    return NextResponse.json({ error: INVITE_EXPIRED_MESSAGE }, { status: 410 });
  }

  return NextResponse.json({
    ownerLabel: formatUserLabel(share.owner),
    ownerDaemonHost: share.ownerDaemonHost,
    workspaceRoot: share.workspaceRoot,
    status: share.status,
    expiresAt: share.expiresAt?.toISOString() ?? null,
    isSelf: share.ownerUserId === user.id,
    alreadyAccepted: share.status === 'active',
    // Only meaningful to the grantee who already accepted it.
    guestHost: share.granteeUserId === user.id ? share.guestHost : null,
  });
}

import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import { db } from "@/lib/db";
import { formatUserLabel, isHostAllowedForShare } from "@/lib/daemon-share/service";
import { isDaemonShareUser, resolveActiveShareForToken } from "@/lib/daemon-share/scope";
import { resolveAuthToken } from "@/lib/auth/middleware";

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  let agents = realtimeHub.getAgentsForUser(user.id);

  // RFC 0035: a share-scoped token must not learn the grantee's daemon
  // inventory. The URL carries no resource, so the row-scoping layer cannot
  // catch this one -- but the *response* does: host names, versions and
  // capabilities of every machine the grantee has online. That is the
  // reconnaissance step for redirecting work onto one of them, so narrow it to
  // the share's own host.
  if (isDaemonShareUser(user)) {
    const binding = await resolveActiveShareForToken(resolveAuthToken(request) || "", user.id);
    if (!binding) return NextResponse.json([], { status: 200 });
    agents = agents.filter((agent) => isHostAllowedForShare(agent.host, binding.guestHost));
  }

  // RFC 0035: a borrowed daemon is a first-class entry in the caller's list --
  // that is what makes the existing cross-daemon project merge work for it for
  // free. But the filesystem underneath belongs to someone else, so mark it so
  // the UI can say whose machine this is.
  const shares = agents.length
    ? await db.daemonShare.findMany({
        where: {
          granteeUserId: user.id,
          status: "active",
          guestHost: { in: agents.map((agent) => agent.host) },
        },
        select: {
          guestHost: true,
          owner: { select: { id: true, email: true, phone: true } },
        },
      })
    : [];
  const sharedByHost = new Map(
    shares
      .filter((share) => share.guestHost)
      .map((share) => [share.guestHost as string, formatUserLabel(share.owner)]),
  );

  return NextResponse.json(
    agents.map((agent) => {
      const ownerLabel = sharedByHost.get(agent.host) ?? null;
      return {
        id: agent.id,
        host: agent.host,
        supportedBackends: agent.supportedBackends,
        runtimeBackendMap: agent.runtimeBackendMap,
        capabilities: agent.capabilities,
        version: agent.version,
        shared: ownerLabel !== null,
        ownerLabel,
      };
    }),
  );
}

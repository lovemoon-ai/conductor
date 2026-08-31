import { NextRequest } from "next/server";

import { authenticateToken } from "@/lib/auth/service";
import {
  isDaemonShareUser,
  isShareHostAllowed,
  resolveActiveShareForToken,
} from "@/lib/daemon-share/scope";

export async function authenticateAgentRequest(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const agentHost = (request.headers.get("x-conductor-host") || "").trim();
  if (!agentHost) return null;
  const token = match[1];
  const user = await authenticateToken(token);
  if (!user) return null;

  // RFC 0035: `agentHost` is asserted by the caller and never verified against
  // the credential. For a `daemon_share` token that gap is the whole attack --
  // the owner holds this token on their own disk, so an unbound host lets them
  // act as any of the grantee's daemons. Pin it to the share's guest host (or
  // one of its fire hosts) before the caller can use it for anything.
  if (isDaemonShareUser(user)) {
    const binding = await resolveActiveShareForToken(token, user.id);
    if (!binding || !isShareHostAllowed(binding, agentHost)) return null;
  }

  return { user, agentHost };
}

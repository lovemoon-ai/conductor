import { NextRequest } from "next/server";

import { authenticateToken } from "@/lib/auth/service";

export async function authenticateAgentRequest(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const agentHost = (request.headers.get("x-conductor-host") || "").trim();
  if (!agentHost) return null;
  const user = await authenticateToken(match[1]);
  if (!user || !agentHost) return null;
  return { user, agentHost };
}

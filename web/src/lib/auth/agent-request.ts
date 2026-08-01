import { NextRequest } from "next/server";

import { authenticateToken } from "@/lib/auth/service";

export async function authenticateAgentRequest(request: NextRequest) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const user = await authenticateToken(match[1]);
  const agentHost = (request.headers.get("x-conductor-host") || "").trim();
  if (!user || !agentHost) return null;
  return { user, agentHost };
}

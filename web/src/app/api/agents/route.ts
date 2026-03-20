import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const agents = realtimeHub.getAgentsForUser(user.id).map((agent) => ({
    id: agent.id,
    host: agent.host,
    supportedBackends: agent.supportedBackends,
    capabilities: agent.capabilities,
    version: agent.version,
  }));
  return NextResponse.json(agents);
}

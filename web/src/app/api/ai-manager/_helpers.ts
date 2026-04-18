import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  requestAiManager,
  type AiManagerAction,
  type RequestAiManagerOutcome,
} from "@/lib/realtime/ai-manager";

export interface AuthorizedRequest {
  userId: string;
  agentHost: string;
}

/**
 * Authenticate the request, parse `agentHost`, and verify the user owns it.
 * Returns either an authorized context or a Response to short-circuit the route.
 */
export async function authorize(
  request: NextRequest,
  agentHost: string | null,
): Promise<AuthorizedRequest | Response> {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  if (!agentHost) {
    return NextResponse.json({ error: "agentHost is required" }, { status: 400 });
  }
  if (agentHost.startsWith("conductor-fire-")) {
    // Fire processes are ephemeral task runners, not daemons; they do not
    // wire up the ai_manager_request handler. Reject early instead of letting
    // the realtime request time out.
    return NextResponse.json(
      { error: "ai-manager is not available on conductor-fire hosts" },
      { status: 400 },
    );
  }
  if (!realtimeHub.hasAgentHost(agentHost, userResult.id)) {
    return NextResponse.json({ error: "agent not connected for this user" }, { status: 404 });
  }
  return { userId: userResult.id, agentHost };
}

/** Map a `requestAiManager` outcome to a JSON Response with the right HTTP status. */
export function outcomeToResponse(outcome: RequestAiManagerOutcome): Response {
  if (outcome.ok) return NextResponse.json(outcome.result);
  switch (outcome.reason) {
    case "agent_offline":
      return NextResponse.json({ error: outcome.message }, { status: 404 });
    case "timeout":
      return NextResponse.json({ error: outcome.message }, { status: 504 });
    case "remote_error":
    default:
      return NextResponse.json({ error: outcome.message }, { status: 502 });
  }
}

export async function callAgent(
  ctx: AuthorizedRequest,
  action: AiManagerAction,
  args?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Response> {
  const outcome = await requestAiManager({
    userId: ctx.userId,
    agentHost: ctx.agentHost,
    action,
    args,
    timeoutMs,
  });
  return outcomeToResponse(outcome);
}

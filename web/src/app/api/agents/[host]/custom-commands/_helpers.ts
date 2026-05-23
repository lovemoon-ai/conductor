import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  requestCustomCommands,
  type CustomCommandsAction,
  type RequestCustomCommandsOutcome,
} from "@/lib/realtime/custom-commands";

const CUSTOM_COMMANDS_CAPABILITY = "custom_commands";

export interface AuthorizedCustomCommandsRequest {
  userId: string;
  agentHost: string;
}

export async function authorizeCustomCommands(
  request: NextRequest,
  rawHost: string | null | undefined,
): Promise<AuthorizedCustomCommandsRequest | Response> {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;

  let host = "";
  try {
    host = decodeURIComponent(rawHost || "").trim();
  } catch {
    return NextResponse.json({ error: "invalid host" }, { status: 400 });
  }
  if (!host) {
    return NextResponse.json({ error: "host required" }, { status: 400 });
  }

  const agent = realtimeHub.getAgentsForUser(userResult.id).find((entry) => entry.host === host);
  if (!agent) {
    return NextResponse.json({ error: "daemon not connected" }, { status: 404 });
  }
  if (!agent.capabilities?.includes(CUSTOM_COMMANDS_CAPABILITY)) {
    return NextResponse.json(
      { error: "daemon does not support custom commands (old version)" },
      { status: 409 },
    );
  }

  return { userId: userResult.id, agentHost: host };
}

export function customCommandsOutcomeToResponse(outcome: RequestCustomCommandsOutcome): Response {
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

export async function callCustomCommands(
  ctx: AuthorizedCustomCommandsRequest,
  action: CustomCommandsAction,
  args?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Response> {
  const outcome = await requestCustomCommands({
    userId: ctx.userId,
    agentHost: ctx.agentHost,
    action,
    args,
    timeoutMs,
  });
  return customCommandsOutcomeToResponse(outcome);
}

import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  requestRemoteExec,
  type RemoteExecAction,
  type RequestRemoteExecOutcome,
} from "@/lib/realtime/remote-exec";

const REMOTE_EXEC_CAPABILITY = "remote_exec";

export interface AuthorizedRemoteExecRequest {
  userId: string;
  agentHost: string;
}

export async function authorizeRemoteExec(
  request: NextRequest,
  rawHost: string | null | undefined,
): Promise<AuthorizedRemoteExecRequest | Response> {
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
  if (!agent.capabilities?.includes(REMOTE_EXEC_CAPABILITY)) {
    // The handshake cannot tell these two apart, and they need different
    // remedies, so name both rather than blaming the version.
    return NextResponse.json(
      {
        error:
          "daemon does not support remote exec — either it predates the feature (upgrade it) " +
          "or it declined via `remote_exec: false` in its config",
      },
      { status: 409 },
    );
  }

  return { userId: userResult.id, agentHost: host };
}

function remoteExecOutcomeToResponse(outcome: RequestRemoteExecOutcome): Response {
  if (outcome.ok) return NextResponse.json(outcome.result);
  switch (outcome.reason) {
    case "agent_offline":
      return NextResponse.json({ error: outcome.message }, { status: 404 });
    case "too_many_inflight":
      return NextResponse.json({ error: outcome.message }, { status: 429 });
    case "timeout":
      return NextResponse.json({ error: outcome.message }, { status: 504 });
    case "remote_error":
    default:
      return NextResponse.json({ error: outcome.message }, { status: 502 });
  }
}

export async function callRemoteExec(
  ctx: AuthorizedRemoteExecRequest,
  action: RemoteExecAction,
  args?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<Response> {
  const outcome = await requestRemoteExec({
    userId: ctx.userId,
    agentHost: ctx.agentHost,
    action,
    args,
    timeoutMs,
  });
  return remoteExecOutcomeToResponse(outcome);
}

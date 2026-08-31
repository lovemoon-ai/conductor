import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  requestDaemonUpdate,
  type DaemonUpdateAction,
  type RequestDaemonUpdateOutcome,
} from "@/lib/realtime/daemon-update";

const UPDATE_DAEMON_CAPABILITY = "update_daemon";

async function authorize(
  request: NextRequest,
  rawHost: string | null | undefined,
): Promise<{ userId: string; agentHost: string } | Response> {
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
  if (!agent.capabilities?.includes(UPDATE_DAEMON_CAPABILITY)) {
    return NextResponse.json(
      { error: "daemon does not support built-in update (old version)" },
      { status: 409 },
    );
  }

  return { userId: userResult.id, agentHost: host };
}

function toResponse(outcome: RequestDaemonUpdateOutcome): Response {
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

async function handle(
  request: NextRequest,
  params: Promise<{ host: string }>,
  action: DaemonUpdateAction,
): Promise<Response> {
  const { host } = await params;
  const authorized = await authorize(request, host);
  if (authorized instanceof Response) return authorized;
  return toResponse(
    await requestDaemonUpdate({
      userId: authorized.userId,
      agentHost: authorized.agentHost,
      action,
    }),
  );
}

/** Start the daemon's built-in upgrade-and-restart. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  return handle(request, params, "start");
}

/** Read the current (or last) update run's progress. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  return handle(request, params, "status");
}

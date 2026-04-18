import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";

const SEMVER_RE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

const requestSchema = z.object({
  targetVersion: z
    .string()
    .trim()
    .refine((v) => v === "latest" || SEMVER_RE.test(v), {
      message: "targetVersion must be 'latest' or a semver string",
    })
    .default("latest"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { host: rawHost } = await params;
  const host = decodeURIComponent(rawHost || "").trim();
  if (!host) {
    return NextResponse.json({ error: "host required" }, { status: 400 });
  }

  const agent = realtimeHub.getAgentsForUser(user.id).find((a) => a.host === host);
  if (!agent) {
    return NextResponse.json({ error: "daemon not connected" }, { status: 404 });
  }
  if (!agent.capabilities?.includes("restart_daemon")) {
    return NextResponse.json(
      { error: "daemon does not support restart (old version)" },
      { status: 409 },
    );
  }

  let rawBody: unknown = {};
  try {
    rawBody = await request.json();
  } catch {
    rawBody = {};
  }
  const parsed = requestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid body" },
      { status: 400 },
    );
  }

  const sent = realtimeHub.sendToAgentHost(user.id, host, {
    type: "restart_daemon",
    payload: {
      request_id: `restart-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      target_version: parsed.data.targetVersion,
    },
  });

  if (!sent) {
    return NextResponse.json({ error: "failed to deliver restart command" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}

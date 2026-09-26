import { NextRequest, NextResponse } from "next/server";
import { getAuthUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import { describeGlobalBackend, findSharedGuestHosts } from "@/lib/tasks/global-backend";
import {
  getGlobalAiBackends,
  MAX_GLOBAL_AI_BACKENDS,
  normalizeGlobalAiBackends,
  setGlobalAiBackends,
  UserPreferencesSchemaUnavailableError,
  type GlobalAiBackend,
} from "@/lib/user-preferences";

// RFC 0041: the daemon × AI backends any project may run its tasks on.

export async function GET(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.tokenScope === "daemon_share") {
    return NextResponse.json({ backends: [] });
  }
  return NextResponse.json({ backends: await getGlobalAiBackends(user.id) });
}

export async function PUT(request: NextRequest) {
  const user = await getAuthUser(request);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (user.tokenScope === "daemon_share") {
    return NextResponse.json(
      { error: "Global AI backends are not available to a shared daemon token" },
      { status: 403 },
    );
  }

  const body = await request.json().catch(() => null);
  const rawList =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).backends
      : undefined;
  if (!Array.isArray(rawList)) {
    return NextResponse.json({ error: "backends must be an array" }, { status: 400 });
  }
  if (rawList.length > MAX_GLOBAL_AI_BACKENDS) {
    return NextResponse.json(
      { error: `At most ${MAX_GLOBAL_AI_BACKENDS} global AI backends are allowed` },
      { status: 400 },
    );
  }
  if (rawList.some((item) => !isEntryShaped(item))) {
    return NextResponse.json(
      { error: "Each backend needs a host and a backend" },
      { status: 400 },
    );
  }
  const requested = normalizeGlobalAiBackends(rawList);

  // New entries must name a backend an own, online daemon advertises right
  // now; entries already saved stay valid while their daemon is offline.
  const existing = await getGlobalAiBackends(user.id);
  const agents = realtimeHub.getAgentsForUser(user.id);
  const shared = await findSharedGuestHosts(
    user.id,
    [...new Set(requested.map((entry) => entry.host))],
  );
  for (const entry of requested) {
    const problem = validateEntry(entry, { existing, agents, shared });
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }
  }

  let saved: GlobalAiBackend[];
  try {
    saved = await setGlobalAiBackends(user.id, requested);
  } catch (error) {
    if (error instanceof UserPreferencesSchemaUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }

  realtimeHub.broadcastToUser(user.id, {
    type: "user_preference_update",
    payload: {
      scope: "global_ai_backends",
      preferences: { backends: saved },
      updated_at: new Date().toISOString(),
    },
  });

  return NextResponse.json({ backends: saved });
}

const isEntryShaped = (item: unknown): boolean =>
  Boolean(item) &&
  typeof item === "object" &&
  !Array.isArray(item) &&
  typeof (item as Record<string, unknown>).host === "string" &&
  typeof (item as Record<string, unknown>).backend === "string" &&
  Boolean(((item as Record<string, unknown>).host as string).trim()) &&
  Boolean(((item as Record<string, unknown>).backend as string).trim());

const validateEntry = (
  entry: GlobalAiBackend,
  context: {
    existing: GlobalAiBackend[];
    agents: Array<{ host: string; supportedBackends: string[] }>;
    shared: Set<string>;
  },
): string | null => {
  const label = describeGlobalBackend(entry);
  if (isConductorFireHost(entry.host)) {
    return `${label}: a conductor fire process cannot be a global AI backend`;
  }
  if (context.shared.has(entry.host)) {
    return `${label}: ${entry.host} is shared with you; only your own daemons can be global AI backends`;
  }
  if (context.existing.some((saved) => saved.host === entry.host && saved.backend === entry.backend)) {
    return null;
  }
  const agent = context.agents.find((candidate) => candidate.host === entry.host);
  if (!agent) {
    return `${label}: daemon ${entry.host} is offline`;
  }
  if (!agent.supportedBackends.includes(entry.backend)) {
    return `${label}: ${entry.host} does not support ${entry.backend}`;
  }
  return null;
};

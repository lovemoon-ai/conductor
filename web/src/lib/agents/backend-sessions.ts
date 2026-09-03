import { randomUUID } from "crypto";
import { realtimeHub, type BackendSessionsResult } from "@/lib/realtime/hub";

const BACKEND_SESSION_LIST_CAPABILITY = "backend_session_list";
// Listing scans each backend's on-disk session store, so allow more headroom
// than the 2s project-agents YAML read (matches the 10s custom-commands RPC).
const BACKEND_SESSIONS_TIMEOUT_MS = 10_000;

export type ListBackendSessionsOutcome =
  | { ok: true; result: BackendSessionsResult }
  | { ok: false; reason: "daemon_offline" | "capability_missing" | "timeout" };

/**
 * Ask the user's daemon at `agentHost` to list the AI sessions stored locally
 * by its backends (claude/codex/...). Requires a live daemon connection that
 * advertises the `backend_session_list` capability.
 */
export async function listBackendSessions(params: {
  userId: string;
  agentHost: string;
  backends?: string[];
  limit?: number;
}): Promise<ListBackendSessionsOutcome> {
  const agent = realtimeHub
    .getAgentsForUser(params.userId)
    .find((entry) => entry.host === params.agentHost);
  if (!agent) {
    return { ok: false, reason: "daemon_offline" };
  }
  const supportsSessionList = agent.capabilities.some(
    (capability) => capability.trim().toLowerCase() === BACKEND_SESSION_LIST_CAPABILITY,
  );
  if (!supportsSessionList) {
    return { ok: false, reason: "capability_missing" };
  }

  const requestId = randomUUID();
  const waitForSessions = realtimeHub.waitForBackendSessions(
    requestId,
    BACKEND_SESSIONS_TIMEOUT_MS,
  );
  const sent = realtimeHub.sendToAgentHost(params.userId, params.agentHost, {
    type: "list_backend_sessions",
    payload: {
      request_id: requestId,
      ...(params.backends && params.backends.length > 0 ? { backends: params.backends } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    },
  });
  if (!sent) {
    realtimeHub.cancelBackendSessions(requestId);
    return { ok: false, reason: "daemon_offline" };
  }

  const result = await waitForSessions;
  if (!result) {
    return { ok: false, reason: "timeout" };
  }
  return { ok: true, result };
}

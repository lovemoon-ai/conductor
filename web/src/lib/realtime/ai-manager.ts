import { randomUUID } from "node:crypto";
import { realtimeHub, type AiManagerResponse } from "./hub";

export type AiManagerAction = "status" | "quota" | "list_accounts" | "switch_account";

export interface RequestAiManagerOptions {
  /** Owning user (for ownership check on the agent connection). */
  userId: string;
  /** Daemon host name (matches the host advertised at connect time). */
  agentHost: string;
  action: AiManagerAction;
  args?: Record<string, unknown>;
  /** Default 15s; switch_account may want longer. */
  timeoutMs?: number;
}

export type RequestAiManagerOutcome =
  | { ok: true; action: AiManagerAction; result: unknown }
  | { ok: false; reason: "agent_offline" | "timeout" | "remote_error"; message: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Request → response over the realtime channel: send `ai_manager_request`
 * to the daemon, await the matching `ai_manager_response`, surface a typed
 * outcome instead of throwing.
 */
export async function requestAiManager(
  opts: RequestAiManagerOptions,
): Promise<RequestAiManagerOutcome> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sent = realtimeHub.sendToAgentHost(opts.userId, opts.agentHost, {
    type: "ai_manager_request",
    payload: {
      request_id: requestId,
      action: opts.action,
      args: opts.args ?? {},
    },
  });

  if (!sent) {
    return { ok: false, reason: "agent_offline", message: `daemon ${opts.agentHost} not connected` };
  }

  let response: AiManagerResponse | null;
  try {
    response = await realtimeHub.waitForAiManagerResponse(
      requestId,
      timeoutMs,
      opts.userId,
      opts.agentHost,
    );
  } finally {
    realtimeHub.cancelAiManagerResponse(requestId);
  }

  if (!response) {
    return { ok: false, reason: "timeout", message: `daemon did not respond within ${timeoutMs}ms` };
  }
  if (response.error) {
    return { ok: false, reason: "remote_error", message: response.error };
  }
  return { ok: true, action: opts.action, result: response.result };
}

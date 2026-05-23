import { randomUUID } from "node:crypto";
import { realtimeHub, type CustomCommandsResponse } from "./hub";

export type CustomCommandsAction = "list" | "run" | "status";

export interface RequestCustomCommandsOptions {
  userId: string;
  agentHost: string;
  action: CustomCommandsAction;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export type RequestCustomCommandsOutcome =
  | { ok: true; action: CustomCommandsAction; result: unknown }
  | { ok: false; reason: "agent_offline" | "timeout" | "remote_error"; message: string };

const DEFAULT_TIMEOUT_MS = 15_000;

export async function requestCustomCommands(
  opts: RequestCustomCommandsOptions,
): Promise<RequestCustomCommandsOutcome> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sent = realtimeHub.sendToAgentHost(opts.userId, opts.agentHost, {
    type: "custom_commands_request",
    payload: {
      request_id: requestId,
      action: opts.action,
      args: opts.args ?? {},
    },
  });

  if (!sent) {
    return { ok: false, reason: "agent_offline", message: `daemon ${opts.agentHost} not connected` };
  }

  let response: CustomCommandsResponse | null;
  try {
    response = await realtimeHub.waitForCustomCommandsResponse(
      requestId,
      timeoutMs,
      opts.userId,
      opts.agentHost,
    );
  } finally {
    realtimeHub.cancelCustomCommandsResponse(requestId);
  }

  if (!response) {
    return { ok: false, reason: "timeout", message: `daemon did not respond within ${timeoutMs}ms` };
  }
  if (response.error) {
    return { ok: false, reason: "remote_error", message: response.error };
  }
  return { ok: true, action: opts.action, result: response.result };
}

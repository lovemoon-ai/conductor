import { randomUUID } from "node:crypto";
import { realtimeHub, type UpdateDaemonResponse } from "./hub";

export type DaemonUpdateAction = "start" | "status";

export interface RequestDaemonUpdateOptions {
  userId: string;
  agentHost: string;
  action: DaemonUpdateAction;
  timeoutMs?: number;
}

export type RequestDaemonUpdateOutcome =
  | { ok: true; action: DaemonUpdateAction; result: unknown }
  | { ok: false; reason: "agent_offline" | "timeout" | "remote_error"; message: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Ask a daemon to start, or report on, its built-in self-update. The daemon
 * answers immediately in both cases: `start` only spawns the detached updater,
 * and `status` reads the updater's journal file, so neither call blocks on the
 * (minutes-long) install.
 */
export async function requestDaemonUpdate(
  opts: RequestDaemonUpdateOptions,
): Promise<RequestDaemonUpdateOutcome> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const sent = realtimeHub.sendToAgentHost(opts.userId, opts.agentHost, {
    type: "update_daemon_request",
    payload: {
      request_id: requestId,
      action: opts.action,
    },
  });

  if (!sent) {
    return { ok: false, reason: "agent_offline", message: `daemon ${opts.agentHost} not connected` };
  }

  let response: UpdateDaemonResponse | null;
  try {
    response = await realtimeHub.waitForUpdateDaemonResponse(
      requestId,
      timeoutMs,
      opts.userId,
      opts.agentHost,
    );
  } finally {
    realtimeHub.cancelUpdateDaemonResponse(requestId);
  }

  if (!response) {
    return { ok: false, reason: "timeout", message: `daemon did not respond within ${timeoutMs}ms` };
  }
  if (response.error) {
    return { ok: false, reason: "remote_error", message: response.error };
  }
  return { ok: true, action: opts.action, result: response.result };
}

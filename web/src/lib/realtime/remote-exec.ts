import { randomUUID } from "node:crypto";
import { realtimeHub, type RemoteExecResponse } from "./hub";

export type RemoteExecAction = "exec" | "status" | "cancel";

export interface RequestRemoteExecOptions {
  userId: string;
  agentHost: string;
  action: RemoteExecAction;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export type RequestRemoteExecOutcome =
  | { ok: true; action: RemoteExecAction; result: unknown }
  | {
      ok: false;
      reason: "agent_offline" | "timeout" | "remote_error" | "too_many_inflight";
      message: string;
    };

const DEFAULT_TIMEOUT_MS = 35_000;

/**
 * Each in-flight exec pins an open HTTP request and a timer on a shared server
 * for as long as its wait window. Without a cap, one account pointing a stalled
 * daemon at the backend could hold arbitrarily many of both and degrade other
 * tenants, so bound the concurrency per user.
 */
const MAX_INFLIGHT_PER_USER = 8;
const inflightByUser = new Map<string, number>();

function acquireSlot(userId: string): boolean {
  const current = inflightByUser.get(userId) ?? 0;
  if (current >= MAX_INFLIGHT_PER_USER) return false;
  inflightByUser.set(userId, current + 1);
  return true;
}

function releaseSlot(userId: string): void {
  const current = inflightByUser.get(userId) ?? 0;
  if (current <= 1) inflightByUser.delete(userId);
  else inflightByUser.set(userId, current - 1);
}

export async function requestRemoteExec(
  opts: RequestRemoteExecOptions,
): Promise<RequestRemoteExecOutcome> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!acquireSlot(opts.userId)) {
    return {
      ok: false,
      reason: "too_many_inflight",
      message: `too many concurrent remote exec requests (limit ${MAX_INFLIGHT_PER_USER}); retry shortly`,
    };
  }

  try {
    return await dispatchRemoteExec(opts, requestId, timeoutMs);
  } finally {
    releaseSlot(opts.userId);
  }
}

async function dispatchRemoteExec(
  opts: RequestRemoteExecOptions,
  requestId: string,
  timeoutMs: number,
): Promise<RequestRemoteExecOutcome> {
  const sent = realtimeHub.sendToAgentHost(opts.userId, opts.agentHost, {
    type: "remote_exec_request",
    payload: {
      request_id: requestId,
      action: opts.action,
      args: opts.args ?? {},
    },
  });

  if (!sent) {
    return { ok: false, reason: "agent_offline", message: `daemon ${opts.agentHost} not connected` };
  }

  const waitPromise = realtimeHub.waitForRemoteExecResponse(
    requestId,
    timeoutMs,
    opts.userId,
    opts.agentHost,
  );
  // Close the gap between "sent" and "waiter registered": if the socket dropped
  // in between, `unregister`'s sweep already ran and could not have seen this
  // waiter, so nothing would ever resolve it before the timeout.
  if (!realtimeHub.hasAgentHost(opts.agentHost, opts.userId)) {
    realtimeHub.cancelRemoteExecResponse(requestId);
  }

  let response: RemoteExecResponse | null;
  try {
    response = await waitPromise;
  } finally {
    realtimeHub.cancelRemoteExecResponse(requestId);
  }

  if (!response) {
    // A disconnect sweep and a real timeout both resolve to null, but they mean
    // very different things to whoever is reading the error.
    if (!realtimeHub.hasAgentHost(opts.agentHost, opts.userId)) {
      return {
        ok: false,
        reason: "agent_offline",
        message: `daemon ${opts.agentHost} disconnected before answering`,
      };
    }
    return { ok: false, reason: "timeout", message: `daemon did not respond within ${timeoutMs}ms` };
  }
  if (response.error) {
    return { ok: false, reason: "remote_error", message: response.error };
  }
  return { ok: true, action: opts.action, result: response.result };
}

import { randomUUID } from "node:crypto";
import { realtimeHub, type RemoteFileResponse } from "./hub";

export type RemoteFileAction = "pull" | "push" | "stat";

export interface RequestRemoteFileOptions {
  userId: string;
  agentHost: string;
  action: RemoteFileAction;
  args?: Record<string, unknown>;
  timeoutMs?: number;
}

export type RequestRemoteFileOutcome =
  | { ok: true; action: RemoteFileAction; result: unknown }
  | { ok: false; reason: "pending"; message: string }
  | {
      ok: false;
      reason: "agent_offline" | "timeout" | "remote_error" | "too_many_inflight";
      message: string;
    };

/** Transfers move real bytes over HTTP, so the daemon side is far slower than
 *  an exec round trip. RFC 0037 sets the per-transfer budget at 300s. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * How long a *detached* request waits before handing the caller back a
 * "still working" answer.
 *
 * A 1 GiB transfer cannot finish inside any HTTP request we are willing to
 * hold open: nginx cuts an idle proxied response at 60s and the websocket
 * waiter gives up at 300s, so blocking until the daemon is done turns every
 * large transfer into a spurious 504 while the bytes are still moving. Short
 * files still complete inside this window and take the fast path; anything
 * longer is polled, exactly as `remote exec` already does for long commands.
 */
const ACK_TIMEOUT_MS = 8_000;

/** Ceiling on how long a detached transfer may keep its slot and its waiter. */
const DETACHED_TIMEOUT_MS = 3_600_000;

/**
 * Same argument as remote exec, only tighter: each in-flight transfer pins an
 * open HTTP request, a timer, and up to `CONDUCTOR_REMOTE_FILE_MAX_BYTES` of
 * server disk for the length of its wait window. Bytes are heavier than exec
 * output, so the per-user budget is half of exec's.
 */
const MAX_INFLIGHT_PER_USER = 4;
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

export async function requestRemoteFile(
  opts: RequestRemoteFileOptions,
): Promise<RequestRemoteFileOutcome> {
  const requestId = randomUUID();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!acquireSlot(opts.userId)) {
    return {
      ok: false,
      reason: "too_many_inflight",
      message: `too many concurrent remote file transfers (limit ${MAX_INFLIGHT_PER_USER}); retry shortly`,
    };
  }

  try {
    return await dispatchRemoteFile(opts, requestId, timeoutMs);
  } finally {
    releaseSlot(opts.userId);
  }
}

/**
 * Send a transfer request and stop waiting once it is clearly not going to
 * finish quickly. `onSettled` fires whenever the daemon does answer, so the
 * transfer record — which is what the client polls — still learns the outcome.
 *
 * The concurrency slot is held for the whole detached lifetime, not just the
 * HTTP request; the daemon is genuinely still working.
 */
export async function requestRemoteFileDetached(
  opts: RequestRemoteFileOptions,
  onSettled: (outcome: RequestRemoteFileOutcome) => void,
): Promise<RequestRemoteFileOutcome> {
  const requestId = randomUUID();

  if (!acquireSlot(opts.userId)) {
    return {
      ok: false,
      reason: "too_many_inflight",
      message: `too many concurrent remote file transfers (limit ${MAX_INFLIGHT_PER_USER}); retry shortly`,
    };
  }

  const settled = dispatchRemoteFile(opts, requestId, opts.timeoutMs ?? DETACHED_TIMEOUT_MS)
    .catch((error): RequestRemoteFileOutcome => ({
      ok: false,
      reason: "remote_error",
      message: error instanceof Error ? error.message : String(error),
    }))
    .finally(() => releaseSlot(opts.userId));

  let acked = false;
  const ack = new Promise<null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ACK_TIMEOUT_MS);
    // Do not hold the process open for a wait nobody is reading.
    timer.unref?.();
    void settled.finally(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  const winner = await Promise.race([
    settled.then((outcome) => {
      acked = true;
      return outcome;
    }),
    ack.then(() => null),
  ]);

  // Whether or not we waited it out, the record must learn the outcome.
  void settled.then(onSettled);

  if (acked && winner) return winner;
  return { ok: false, reason: "pending", message: "daemon is still transferring" };
}

async function dispatchRemoteFile(
  opts: RequestRemoteFileOptions,
  requestId: string,
  timeoutMs: number,
): Promise<RequestRemoteFileOutcome> {
  const sent = realtimeHub.sendToAgentHost(opts.userId, opts.agentHost, {
    type: "remote_file_request",
    payload: {
      request_id: requestId,
      action: opts.action,
      args: opts.args ?? {},
    },
  });

  if (!sent) {
    return { ok: false, reason: "agent_offline", message: `daemon ${opts.agentHost} not connected` };
  }

  const waitPromise = realtimeHub.waitForRemoteFileResponse(
    requestId,
    timeoutMs,
    opts.userId,
    opts.agentHost,
  );
  // Close the gap between "sent" and "waiter registered": if the socket dropped
  // in between, `unregister`'s sweep already ran and could not have seen this
  // waiter, so nothing would ever resolve it before the timeout.
  if (!realtimeHub.hasAgentHost(opts.agentHost, opts.userId)) {
    realtimeHub.cancelRemoteFileResponse(requestId);
  }

  let response: RemoteFileResponse | null;
  try {
    response = await waitPromise;
  } finally {
    realtimeHub.cancelRemoteFileResponse(requestId);
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

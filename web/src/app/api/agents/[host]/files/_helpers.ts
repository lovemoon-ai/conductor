import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  requestRemoteFile,
  requestRemoteFileDetached,
  type RemoteFileAction,
  type RequestRemoteFileOutcome,
} from "@/lib/realtime/remote-file";
import { getTransfer, updateTransfer, type TransferRecord } from "@/lib/transfers/transfer-store";

const REMOTE_FILE_CAPABILITY = "remote_file";

export const NUL = String.fromCharCode(0);

export const noNul = (label: string) =>
  ({ message: `${label} must not contain NUL bytes` }) as const;

export interface AuthorizedRemoteFileRequest {
  userId: string;
  agentHost: string;
}

/**
 * Owner + host, without requiring the daemon to be online.
 *
 * Used by the operations that only touch this server's own disk — reading a
 * transfer's status, streaming its staged bytes, deleting it. Demanding a live
 * daemon for those made a fully-staged 300 MB download unfetchable the moment
 * the laptop slept, with the correct bytes sitting right here and the user
 * unable even to delete them.
 *
 * This is not a weaker check: daemon-share scoping pins `{host}` in
 * `getAuthUser` independently of the hub, and the record is still matched on
 * both `userId` and `agentHost` by the caller.
 */
export async function authorizeTransferOwner(
  request: NextRequest,
  rawHost: string | null | undefined,
): Promise<AuthorizedRemoteFileRequest | Response> {
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
  return { userId: userResult.id, agentHost: host };
}

/** Owner + host + a connected daemon that advertises `remote_file`. Required
 *  only by the operations that actually send the daemon a request. */
export async function authorizeRemoteFile(
  request: NextRequest,
  rawHost: string | null | undefined,
): Promise<AuthorizedRemoteFileRequest | Response> {
  const owner = await authorizeTransferOwner(request, rawHost);
  if (owner instanceof Response) return owner;
  const { userId, agentHost: host } = owner;

  const agent = realtimeHub.getAgentsForUser(userId).find((entry) => entry.host === host);
  if (!agent) {
    return NextResponse.json({ error: "daemon not connected" }, { status: 404 });
  }
  if (!agent.capabilities?.includes(REMOTE_FILE_CAPABILITY)) {
    // The handshake cannot tell these two apart, and they need different
    // remedies, so name both rather than blaming the version.
    return NextResponse.json(
      {
        error:
          "daemon does not support remote file transfer — either it predates the feature (upgrade it) " +
          "or it declined via `remote_file: false` in its config",
      },
      { status: 409 },
    );
  }

  return { userId, agentHost: host };
}

/**
 * Resolve `{host}` + `{transferId}` together. The record is owner-scoped and
 * additionally pinned to the host in the URL, so a transfer staged for one
 * daemon can never be driven through another.
 */
export async function resolveTransfer(
  request: NextRequest,
  params: Promise<{ host: string; transferId: string }>,
  options: { requireDaemon?: boolean } = {},
): Promise<{ ctx: AuthorizedRemoteFileRequest; transfer: TransferRecord } | { error: Response }> {
  const { host, transferId: rawTransferId } = await params;
  const ctx = options.requireDaemon
    ? await authorizeRemoteFile(request, host)
    : await authorizeTransferOwner(request, host);
  if (ctx instanceof Response) return { error: ctx };

  let transferId = "";
  try {
    transferId = decodeURIComponent(rawTransferId || "").trim();
  } catch {
    return { error: NextResponse.json({ error: "invalid transferId" }, { status: 400 }) };
  }
  if (!transferId) {
    return { error: NextResponse.json({ error: "transferId required" }, { status: 400 }) };
  }

  const transfer = getTransfer(transferId, ctx.userId);
  if (!transfer || transfer.agentHost !== ctx.agentHost) {
    return { error: NextResponse.json({ error: "transfer not found" }, { status: 404 }) };
  }
  return { ctx, transfer };
}

/**
 * Everything the CLI needs to verify and place a downloaded file.
 *
 * `sha256`/`sizeBytes`/`mode`/`name` are not decoration: without them the
 * client's integrity checks silently degrade to no-ops, because `undefined`
 * fails every `if (created.sha256 && ...)` guard rather than raising.
 */
export function transferSummary(transfer: TransferRecord) {
  return {
    transferId: transfer.transferId,
    direction: transfer.direction,
    status: transfer.status,
    sizeBytes: transfer.sizeBytes,
    // The resume cursor. A client that lost its own offset (or is retrying a
    // chunk) reads it here instead of guessing and eating a 409.
    receivedBytes: transfer.receivedBytes,
    sha256: transfer.sha256,
    mode: transfer.mode,
    name: transfer.name,
    remotePath: transfer.remotePath,
    error: transfer.error,
  };
}

/**
 * Ask the daemon to move bytes, and answer the client as soon as we know
 * whether it started — not when it finishes.
 *
 * Holding the HTTP request open for the whole transfer cannot work at these
 * sizes: nginx cuts an idle proxied response at 60s and the websocket waiter
 * gives up at 300s, so a 1 GiB transfer would become a spurious 504 while the
 * bytes were still moving. The outcome is written back onto the transfer
 * record when it eventually arrives, and the client polls
 * `GET /files/{transferId}` for it — the same two-phase shape `remote exec`
 * already uses for long commands.
 */
export async function callRemoteFileDetached(
  ctx: AuthorizedRemoteFileRequest,
  action: RemoteFileAction,
  transferId: string,
  args: Record<string, unknown>,
  applyResult: (result: unknown) => void,
): Promise<RequestRemoteFileOutcome> {
  return requestRemoteFileDetached(
    { userId: ctx.userId, agentHost: ctx.agentHost, action, args },
    (outcome) => {
      if (outcome.ok) {
        applyResult(outcome.result);
        return;
      }
      if (outcome.reason === "pending") return;
      // A failure that arrives after the HTTP request is gone still has to land
      // on the record, or the client polls a "delivering" transfer forever.
      updateTransfer(transferId, { status: "failed", error: outcome.message });
    },
  );
}

export async function callRemoteFile(
  ctx: AuthorizedRemoteFileRequest,
  action: RemoteFileAction,
  args?: Record<string, unknown>,
  timeoutMs?: number,
): Promise<RequestRemoteFileOutcome> {
  return requestRemoteFile({
    userId: ctx.userId,
    agentHost: ctx.agentHost,
    action,
    args,
    timeoutMs,
  });
}

/**
 * A daemon that answers "no" is not an HTTP failure: the transfer record keeps
 * the reason and the CLI reads it from `GET /files/{transferId}`. Only an
 * exhausted concurrency budget gets its own status, because 429 is the signal
 * the caller must back off rather than inspect the transfer.
 */
export function tooManyInflightResponse(outcome: RequestRemoteFileOutcome): Response | null {
  if (!outcome.ok && outcome.reason === "too_many_inflight") {
    return NextResponse.json({ error: outcome.message }, { status: 429 });
  }
  return null;
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  authorizeRemoteFile,
  callRemoteFileDetached,
  noNul,
  NUL,
  transferSummary,
  tooManyInflightResponse,
} from "./_helpers";
import { signTransferToken } from "@/lib/transfers/transfer-token";
import {
  createTransfer,
  getTransfer,
  remoteFileMaxBytes,
  updateTransfer,
  type TransferRecord,
} from "@/lib/transfers/transfer-store";

export const runtime = "nodejs";

const requestSchema = z.object({
  direction: z.enum(["up", "down"]),
  remotePath: z
    .string()
    .trim()
    .min(1, "remotePath is required")
    .refine((value) => !value.includes(NUL), noNul("remotePath")),
  name: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !value.includes(NUL), noNul("name"))
    .optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i, "sha256 must be a hex digest").optional(),
  mode: z.number().int().nonnegative().max(0o7777).optional(),
});

/**
 * Record a completed `push`.
 *
 * Called from two places — inline when the daemon is quick, and from the
 * detached callback when it is not — so the bookkeeping must live in one
 * function. Returns null when the daemon claimed success without staging
 * anything, which is a failure however it is reported.
 */
function finishDownload(
  ctx: { userId: string },
  transferId: string,
  result: unknown,
): TransferRecord | null {
  const reported = (result ?? {}) as { mode?: number; name?: string };
  const staged = getTransfer(transferId, ctx.userId);
  if (!staged?.sha256 || typeof staged.sizeBytes !== "number") {
    updateTransfer(transferId, {
      status: "failed",
      error: "daemon reported success but staged no content",
    });
    return null;
  }
  // Deliberately do NOT take `sha256`/`sizeBytes` from the daemon. It computed
  // those from a separate read of the source file, so on a file still being
  // written they describe neither each other nor the bytes that actually
  // arrived. `writeTransferContent` already measured the staged blob, and that
  // is what this server will serve — so that is what the client must verify
  // against. Only `mode` and `name` come from the daemon: they are properties
  // of the remote file that the bytes cannot reveal.
  return updateTransfer(transferId, {
    status: "ready",
    error: null,
    ...(typeof reported.mode === "number" ? { mode: reported.mode } : {}),
    ...(typeof reported.name === "string" && reported.name ? { name: reported.name } : {}),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ host: string }> },
) {
  const { host } = await params;
  const ctx = await authorizeRemoteFile(request, host);
  if (ctx instanceof Response) return ctx;

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

  const maxBytes = remoteFileMaxBytes();
  if (parsed.data.sizeBytes !== undefined && parsed.data.sizeBytes > maxBytes) {
    return NextResponse.json({ error: `file too large (limit ${maxBytes} bytes)` }, { status: 413 });
  }

  let transfer;
  try {
    transfer = createTransfer({
      userId: ctx.userId,
      agentHost: ctx.agentHost,
      direction: parsed.data.direction,
      remotePath: parsed.data.remotePath,
      name: parsed.data.name,
      sizeBytes: parsed.data.sizeBytes,
      sha256: parsed.data.sha256,
      mode: parsed.data.mode,
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "TRANSFER_LIMIT") {
      return NextResponse.json({ error: (error as Error).message }, { status: 429 });
    }
    // 507: the request is fine, this server just has no room for it right now
    // — either the staging budget is spoken for or the volume is nearly full.
    if (code === "TRANSFER_BUDGET") {
      return NextResponse.json({ error: (error as Error).message }, { status: 507 });
    }
    throw error;
  }

  if (transfer.direction === "up") {
    // The bytes are not here yet: the CLI PUTs them, then calls `deliver`.
    return NextResponse.json({ transferId: transfer.transferId, status: transfer.status });
  }

  // Down: ask the daemon to push now, so by the time this returns the staged
  // bytes are already fetchable and the CLI only has to GET them.
  const outcome = await callRemoteFileDetached(
    ctx,
    "push",
    transfer.transferId,
    {
      transferId: transfer.transferId,
      transferToken: signTransferToken({
        transferId: transfer.transferId,
        agentHost: ctx.agentHost,
        purpose: "push",
      }),
      remotePath: transfer.remotePath,
    },
    (result) => finishDownload(ctx, transfer.transferId, result),
  );

  // Still uploading: the client polls `GET /files/{id}` until it goes ready.
  if (!outcome.ok && outcome.reason === "pending") {
    return NextResponse.json({ transferId: transfer.transferId, status: "requested" });
  }

  const throttled = tooManyInflightResponse(outcome);
  if (throttled) {
    updateTransfer(transfer.transferId, { status: "failed", error: "too many concurrent transfers" });
    return throttled;
  }

  if (!outcome.ok) {
    updateTransfer(transfer.transferId, { status: "failed", error: outcome.message });
    return NextResponse.json({
      transferId: transfer.transferId,
      status: "failed",
      error: outcome.message,
    });
  }

  const finished = finishDownload(ctx, transfer.transferId, outcome.result);
  if (!finished) {
    return NextResponse.json({
      transferId: transfer.transferId,
      status: "failed",
      error: "daemon reported success but staged no content",
    });
  }
  return NextResponse.json(transferSummary(finished));
}

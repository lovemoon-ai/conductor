import { NextRequest, NextResponse } from "next/server";

import { callRemoteFileDetached, resolveTransfer, tooManyInflightResponse } from "../../_helpers";
import { signTransferToken } from "@/lib/transfers/transfer-token";
import { updateTransfer } from "@/lib/transfers/transfer-store";

export const runtime = "nodejs";

/** Hand a staged upload to the daemon: it pulls the bytes back over HTTP and
 *  writes them to `remotePath`. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; transferId: string }> },
) {
  const resolved = await resolveTransfer(request, params, { requireDaemon: true });
  if ("error" in resolved) return resolved.error;
  const { ctx, transfer } = resolved;

  if (transfer.direction !== "up") {
    return NextResponse.json({ error: "transfer is not an upload" }, { status: 409 });
  }
  if (transfer.status !== "uploaded" && transfer.status !== "ready") {
    return NextResponse.json(
      { error: `transfer is ${transfer.status}; upload its content first` },
      { status: 409 },
    );
  }

  updateTransfer(transfer.transferId, { status: "delivering", error: null });

  const outcome = await callRemoteFileDetached(
    ctx,
    "pull",
    transfer.transferId,
    {
      transferId: transfer.transferId,
      transferToken: signTransferToken({
        transferId: transfer.transferId,
        agentHost: ctx.agentHost,
        purpose: "pull",
      }),
      remotePath: transfer.remotePath,
      name: transfer.name,
      sha256: transfer.sha256,
      sizeBytes: transfer.sizeBytes,
      mode: transfer.mode,
    },
    // The daemon's resolved path is not persisted: the record already has
    // `remotePath`, and nothing reads a second copy of it.
    () => updateTransfer(transfer.transferId, { status: "ready", error: null }),
  );

  // Still going: the client polls `GET /files/{id}` for the outcome.
  if (!outcome.ok && outcome.reason === "pending") {
    return NextResponse.json({ transferId: transfer.transferId, status: "delivering" });
  }

  const throttled = tooManyInflightResponse(outcome);
  if (throttled) {
    updateTransfer(transfer.transferId, { status: "uploaded", error: null });
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

  const result = (outcome.result ?? {}) as { bytesWritten?: number; path?: string };
  updateTransfer(transfer.transferId, { status: "ready", error: null });
  return NextResponse.json({
    transferId: transfer.transferId,
    status: "ready",
    ...(typeof result.bytesWritten === "number" ? { bytesWritten: result.bytesWritten } : {}),
    // The daemon may have resolved `remotePath` differently (a directory
    // destination keeps the source name), so report where the bytes landed.
    ...(typeof result.path === "string" ? { path: result.path } : {}),
  });
}

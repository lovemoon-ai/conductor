import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import { authenticateAgentRequest } from "@/lib/auth/agent-request";
import {
  getTransfer,
  openTransferContent,
  parseContentRange,
  parseRangeHeader,
  remoteFileMaxBytes,
  updateTransfer,
  writeTransferContent,
  type TransferRecord,
} from "@/lib/transfers/transfer-store";
import { verifyTransferToken, type TransferTokenPurpose } from "@/lib/transfers/transfer-token";

export const runtime = "nodejs";

/**
 * Bearer + `X-Conductor-Host` proves *a* daemon of this user is calling;
 * the transfer token proves it is the daemon this specific transfer was
 * addressed to, for this specific direction. Both are required.
 */
async function authorizeAgentTransfer(
  request: NextRequest,
  params: Promise<{ transferId: string }>,
  purpose: TransferTokenPurpose,
): Promise<{ transfer: TransferRecord } | { error: Response }> {
  const auth = await authenticateAgentRequest(request);
  if (!auth) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };

  const { transferId } = await params;
  const transferToken = request.headers.get("x-conductor-transfer-token") || "";
  if (!verifyTransferToken(transferToken, { transferId, agentHost: auth.agentHost, purpose })) {
    return { error: NextResponse.json({ error: "Transfer not found" }, { status: 404 }) };
  }

  const transfer = getTransfer(transferId, auth.user.id);
  if (!transfer || transfer.agentHost !== auth.agentHost) {
    return { error: NextResponse.json({ error: "Transfer not found" }, { status: 404 }) };
  }
  return { transfer };
}

/** The `pull` half: the daemon downloads a staged upload and writes it to disk. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const authorized = await authorizeAgentTransfer(request, params, "pull");
  if ("error" in authorized) return authorized.error;
  const { transfer } = authorized;

  if (transfer.direction !== "up") {
    return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
  }
  if (transfer.status === "staged") {
    return NextResponse.json({ error: "transfer content not uploaded yet" }, { status: 409 });
  }

  const range = parseRangeHeader(request.headers.get("range"));
  const body = await openTransferContent(transfer.transferId, range);
  if (!body) return NextResponse.json({ error: "Transfer body missing" }, { status: 404 });
  if ("unsatisfiable" in body) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${body.totalBytes}`,
      },
    });
  }

  return new NextResponse(Readable.toWeb(body.stream) as ReadableStream, {
    status: body.partial ? 206 : 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.sizeBytes),
      "Accept-Ranges": "bytes",
      ...(body.partial
        ? { "Content-Range": `bytes ${body.start}-${body.end}/${body.totalBytes}` }
        : {}),
      "Cache-Control": "private, no-store",
      ...(transfer.sha256 ? { ETag: `"${transfer.sha256}"` } : {}),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The `push` half: the daemon uploads a remote file so the CLI can fetch it. */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ transferId: string }> },
) {
  const authorized = await authorizeAgentTransfer(request, params, "push");
  if ("error" in authorized) return authorized.error;
  const { transfer } = authorized;

  if (transfer.direction !== "down") {
    return NextResponse.json({ error: "Transfer not found" }, { status: 404 });
  }
  if (transfer.status === "failed" || transfer.status === "cancelled") {
    return NextResponse.json({ error: `transfer is ${transfer.status}` }, { status: 409 });
  }

  const maxBytes = remoteFileMaxBytes();
  const rawRange = request.headers.get("content-range");
  const range = rawRange ? parseContentRange(rawRange) : null;
  if (rawRange && !range) {
    return NextResponse.json(
      { error: "invalid Content-Range (expected `bytes <start>-<end>/<total>`)" },
      { status: 400 },
    );
  }
  if (range && range.total > maxBytes) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && (range?.start ?? 0) + declared > maxBytes) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  if (!request.body) {
    return NextResponse.json({ error: "body required" }, { status: 400 });
  }

  let written;
  try {
    written = await writeTransferContent(
      transfer.transferId,
      Readable.from(request.body as unknown as AsyncIterable<Uint8Array>),
      { maxBytes, start: range?.start, total: range?.total ?? null },
    );
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    // A chunk that lands at the wrong offset (or contradicts the total it
    // declared earlier) is recoverable: the daemon reads `receivedBytes` and
    // resumes. Only a genuine failure kills the transfer.
    if (code === "TRANSFER_OFFSET_MISMATCH") {
      return NextResponse.json(
        {
          error: (error as Error).message,
          receivedBytes: (error as { receivedBytes?: number }).receivedBytes ?? transfer.receivedBytes,
        },
        { status: 409 },
      );
    }
    if (code === "TRANSFER_TOTAL_MISMATCH" || code === "TRANSFER_RANGE_INVALID") {
      return NextResponse.json({ error: (error as Error).message }, { status: 400 });
    }
    updateTransfer(transfer.transferId, {
      status: "failed",
      error: code === "TRANSFER_TOO_LARGE" ? "file too large" : "failed to stage transfer content",
    });
    if (code === "TRANSFER_TOO_LARGE") {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }
    return NextResponse.json({ error: "failed to stage transfer content" }, { status: 500 });
  }

  if (!written.complete) {
    return NextResponse.json({
      transferId: transfer.transferId,
      status: transfer.status,
      receivedBytes: written.receivedBytes,
      complete: false,
    });
  }

  updateTransfer(transfer.transferId, {
    status: "uploaded",
    error: null,
    sizeBytes: written.sizeBytes,
    sha256: written.sha256,
  });

  return NextResponse.json({
    transferId: transfer.transferId,
    status: "uploaded",
    receivedBytes: written.receivedBytes,
    complete: true,
    sizeBytes: written.sizeBytes,
    sha256: written.sha256,
  });
}

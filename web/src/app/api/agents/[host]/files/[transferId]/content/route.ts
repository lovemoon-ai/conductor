import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import { resolveTransfer } from "../../_helpers";
import {
  openTransferContent,
  parseContentRange,
  parseRangeHeader,
  remoteFileMaxBytes,
  updateTransfer,
  writeTransferContent,
} from "@/lib/transfers/transfer-store";

export const runtime = "nodejs";

/** CLI → Web: stage the bytes of an upload before `deliver` hands them to the
 *  daemon. Chunked with `Content-Range`, or the whole body when it is absent. */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; transferId: string }> },
) {
  // Fail before the caller streams 32 MiB at a daemon that cannot receive it.
  const resolved = await resolveTransfer(request, params, { requireDaemon: true });
  if ("error" in resolved) return resolved.error;
  const { transfer } = resolved;

  if (transfer.direction !== "up") {
    return NextResponse.json({ error: "transfer is not an upload" }, { status: 409 });
  }
  if (transfer.status !== "staged" && transfer.status !== "uploaded") {
    return NextResponse.json(
      { error: `transfer is ${transfer.status} and no longer accepts content` },
      { status: 409 },
    );
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
    if (code === "TRANSFER_TOO_LARGE") {
      return NextResponse.json({ error: "file too large" }, { status: 413 });
    }
    if (code === "TRANSFER_OFFSET_MISMATCH") {
      // The client's cursor and ours disagree; hand back the truth so it can
      // seek there and resume instead of restarting the file.
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

  // The client declared these at create time; a mismatch means the bytes on
  // disk are not the file it thinks it is sending, so refuse before the daemon
  // ever sees them. The record stays `staged` so a retry is still possible.
  if (transfer.sha256 && transfer.sha256.toLowerCase() !== written.sha256) {
    return NextResponse.json({ error: "sha256 mismatch" }, { status: 400 });
  }
  if (transfer.sizeBytes !== null && transfer.sizeBytes !== written.sizeBytes) {
    return NextResponse.json({ error: "sizeBytes mismatch" }, { status: 400 });
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

/** Web → CLI: hand back the bytes the daemon pushed for a download. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ host: string; transferId: string }> },
) {
  const resolved = await resolveTransfer(request, params);
  if ("error" in resolved) return resolved.error;
  const { transfer } = resolved;

  if (transfer.direction !== "down") {
    return NextResponse.json({ error: "transfer is not a download" }, { status: 409 });
  }
  if (transfer.status !== "ready" && transfer.status !== "uploaded") {
    return NextResponse.json(
      { error: `transfer is ${transfer.status} and has no content yet` },
      { status: 409 },
    );
  }

  const range = parseRangeHeader(request.headers.get("range"));
  const body = await openTransferContent(transfer.transferId, range);
  if (!body) return NextResponse.json({ error: "transfer content missing" }, { status: 404 });
  if ("unsatisfiable" in body) {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${body.totalBytes}`,
      },
    });
  }

  const asciiName = transfer.name.replace(/[^A-Za-z0-9._-]+/g, "-") || "file";
  return new NextResponse(Readable.toWeb(body.stream) as ReadableStream, {
    status: body.partial ? 206 : 200,
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(body.sizeBytes),
      "Accept-Ranges": "bytes",
      ...(body.partial
        ? { "Content-Range": `bytes ${body.start}-${body.end}/${body.totalBytes}` }
        : {}),
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(transfer.name)}`,
      "Cache-Control": "private, no-store",
      ...(transfer.sha256 ? { ETag: `"${transfer.sha256}"` } : {}),
      "X-Content-Type-Options": "nosniff",
    },
  });
}

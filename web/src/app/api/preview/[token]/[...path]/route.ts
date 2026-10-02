import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import { forgetPreviewFile, getPreviewFile, normalizePreviewPath } from "@/lib/previews/preview-store";
import { openTransferContent, parseRangeHeader } from "@/lib/transfers/transfer-store";
import { previewContentType } from "@/shared/utils/file-preview";

export const runtime = "nodejs";

/**
 * Every response of this route — errors included — leaves through here.
 *
 * The files are written by an AI and served from the app's own origin, where
 * the signed-in user's token sits in `localStorage`. `sandbox` without
 * `allow-same-origin` puts the document in an opaque origin, so its scripts
 * can run but cannot read that storage or call the API as the user. One
 * response without the header would undo that for the whole origin, which is
 * why no branch below builds its own.
 *
 * `Access-Control-Allow-Origin: *` is the other half: from an opaque origin
 * even a sibling `data.json` is cross-origin, so `fetch`, ES modules and fonts
 * need it. It grants nothing extra — the token in the URL is the credential.
 */
function respond(body: BodyInit | null, status: number, headers: Record<string, string>): NextResponse {
  return new NextResponse(body, {
    status,
    headers: {
      ...headers,
      "Content-Security-Policy": "sandbox allow-scripts allow-popups allow-forms allow-modals",
      "X-Content-Type-Options": "nosniff",
      "Access-Control-Allow-Origin": "*",
      // The URL is a credential: keep it out of caches and outbound referrers.
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

function fail(status: number, message: string): NextResponse {
  return respond(message, status, { "Content-Type": "text/plain; charset=utf-8" });
}

const EXPIRED = "This preview link has expired. Open the file again from the chat.";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; path: string[] }> },
) {
  const { token, path: segments } = await params;
  const relativePath = normalizePreviewPath(segments ?? []);
  if (!relativePath) return fail(404, "file not found");

  // One retry: a blob can be swept by the transfer TTL while its preview is
  // still alive, in which case the file is simply fetched again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const file = await getPreviewFile(token, relativePath);
    if (!file) return fail(404, EXPIRED);
    if (!file.ok) return fail(file.status, file.message);

    // Ranges are what let a video seek (and play at all, in Safari).
    const content = await openTransferContent(
      file.transferId,
      parseRangeHeader(request.headers.get("range")),
    );
    if (!content) {
      forgetPreviewFile(token, relativePath, file.sizeBytes);
      continue;
    }
    if ("unsatisfiable" in content) {
      return respond(null, 416, { "Content-Range": `bytes */${content.totalBytes}` });
    }

    const contentType = previewContentType(relativePath);
    return respond(Readable.toWeb(content.stream) as ReadableStream, content.partial ? 206 : 200, {
      "Content-Type": contentType ?? "application/octet-stream",
      "Content-Length": String(content.sizeBytes),
      "Accept-Ranges": "bytes",
      ...(content.partial
        ? { "Content-Range": `bytes ${content.start}-${content.end}/${content.totalBytes}` }
        : {}),
      // A sandboxed document cannot host the browser's PDF viewer, and an
      // unknown type has no safe inline rendering: hand both over as files.
      ...(!contentType || contentType === "application/pdf"
        ? { "Content-Disposition": "attachment" }
        : {}),
    });
  }
  return fail(502, "the daemon did not deliver this file");
}

import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { NextRequest, NextResponse } from "next/server";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentByStorageKey, taskAttachmentTtlMs, writeTaskAttachmentStream } from "@/lib/tasks/task-file-storage";

export const runtime = "nodejs";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".avi", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".webm"]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;
  const { taskId } = await params;

  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: { id: true, achievedAt: true },
  });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (task.achievedAt) {
    return NextResponse.json({ error: "Archived tasks are read-only" }, { status: 409 });
  }

  const declaredRequestBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredRequestBytes) && declaredRequestBytes > MAX_ATTACHMENT_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  if (!request.body) return NextResponse.json({ error: "file required" }, { status: 400 });
  let stored;
  try {
    const contentType = request.headers.get("content-type");
    if (!contentType) throw new Error("missing content type");
    const parser = Busboy({
      headers: { "content-type": contentType },
      limits: { files: 1, fields: 0, fileSize: MAX_ATTACHMENT_BYTES + 1 },
    });
    stored = await new Promise<Awaited<ReturnType<typeof writeTaskAttachmentStream>>>((resolve, reject) => {
      let upload: Promise<Awaited<ReturnType<typeof writeTaskAttachmentStream>>> | undefined;
      let rejectedType: Error | undefined;
      parser.on("file", (fieldName, stream, info) => {
        if (fieldName !== "file" || upload) {
          stream.resume();
          return;
        }
        if (info.mimeType.startsWith("video/") || VIDEO_EXTENSIONS.has(path.extname(info.filename).toLowerCase())) {
          rejectedType = Object.assign(new Error("video attachments are not supported"), { code: "ATTACHMENT_VIDEO" });
          stream.resume();
          return;
        }
        upload = writeTaskAttachmentStream({
          taskId,
          fileName: info.filename,
          stream,
          mimeType: info.mimeType,
          maxBytes: MAX_ATTACHMENT_BYTES,
        });
        void upload.catch((error) => parser.destroy(error as Error));
      });
      parser.once("error", reject);
      parser.once("filesLimit", () => reject(Object.assign(new Error("only one file is allowed"), { code: "ATTACHMENT_FILE_LIMIT" })));
      parser.once("finish", () => {
        if (rejectedType) reject(rejectedType);
        else if (!upload) reject(Object.assign(new Error("file required"), { code: "ATTACHMENT_REQUIRED" }));
        else upload.then(resolve, reject);
      });
      const source = Readable.from(request.body as unknown as AsyncIterable<Uint8Array>);
      let requestBytes = 0;
      const requestMeter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          requestBytes += chunk.byteLength;
          if (requestBytes > MAX_ATTACHMENT_BYTES + MAX_MULTIPART_OVERHEAD_BYTES) {
            callback(Object.assign(new Error("request too large"), { code: "ATTACHMENT_TOO_LARGE" }));
            return;
          }
          callback(null, chunk);
        },
      });
      void pipeline(source, requestMeter, parser).catch(reject);
    });
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code === "ATTACHMENT_TOO_LARGE") return NextResponse.json({ error: "file too large" }, { status: 413 });
    if (code === "ATTACHMENT_EMPTY") return NextResponse.json({ error: "file is empty" }, { status: 400 });
    if (code === "ATTACHMENT_VIDEO") return NextResponse.json({ error: "video attachments are not supported" }, { status: 415 });
    if (code === "ATTACHMENT_REQUIRED") return NextResponse.json({ error: "file required" }, { status: 400 });
    if (code === "ATTACHMENT_FILE_LIMIT") return NextResponse.json({ error: "upload one file per request" }, { status: 400 });
    return NextResponse.json({ error: "invalid multipart form" }, { status: 400 });
  }
  let attachment;
  try {
    attachment = await db.taskAttachment.create({
      data: {
        id: stored.id,
        taskId,
        originalName: stored.name,
        storageKey: stored.storageKey,
        mimeType: stored.mimeType,
        kind: stored.kind,
        sizeBytes: stored.sizeBytes,
        sha256: stored.sha256,
        status: "uploaded",
        expiresAt: new Date(Date.now() + taskAttachmentTtlMs()),
      },
    });
  } catch (error) {
    await deleteTaskAttachmentByStorageKey(taskId, stored.storageKey).catch(() => undefined);
    throw error;
  }

  return NextResponse.json({
    attachment: {
      id: attachment.id,
      name: attachment.originalName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      kind: attachment.kind,
      sha256: attachment.sha256,
      status: attachment.status,
      downloadUrl: `/api/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(attachment.id)}`,
      createdAt: attachment.createdAt.toISOString(),
      expiresAt: attachment.expiresAt?.toISOString(),
    },
  }, { status: 201 });
}

import { Buffer } from "node:buffer";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deleteTaskAttachmentByStorageKey, writeTaskAttachment } from "@/lib/tasks/task-file-storage";

export const runtime = "nodejs";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
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
  const formData = await request.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "invalid multipart form" }, { status: 400 });
  const fileValue = formData.get("file");
  if (!(fileValue instanceof File)) {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }
  if (fileValue.size <= 0) {
    return NextResponse.json({ error: "file is empty" }, { status: 400 });
  }
  if (fileValue.size > MAX_ATTACHMENT_BYTES) {
    return NextResponse.json({ error: "file too large" }, { status: 413 });
  }
  if (fileValue.type.startsWith("video/") || VIDEO_EXTENSIONS.has(path.extname(fileValue.name).toLowerCase())) {
    return NextResponse.json({ error: "video attachments are not supported" }, { status: 415 });
  }

  const stored = await writeTaskAttachment({
    taskId,
    fileName: fileValue.name,
    bytes: Buffer.from(await fileValue.arrayBuffer()),
    mimeType: fileValue.type,
  });
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
        expiresAt: new Date(Date.now() + STAGING_TTL_MS),
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

import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { openTaskAttachmentStreamByStorageKey } from "@/lib/tasks/task-file-storage";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string; attachmentId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId, attachmentId } = await params;
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: { id: true },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const attachment = await db.taskAttachment.findFirst({
    where: { id: attachmentId, taskId },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const body = await openTaskAttachmentStreamByStorageKey(taskId, attachment.storageKey);
  if (!body) {
    return NextResponse.json({ error: "Attachment body missing" }, { status: 404 });
  }

  return new NextResponse(Readable.toWeb(body.stream) as ReadableStream, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(body.sizeBytes),
      "Content-Disposition": `inline; filename="${attachment.originalName}"`,
      ETag: `"${attachment.sha256}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

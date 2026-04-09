import { NextRequest, NextResponse } from "next/server";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { getMessageAttachments, normalizeMessageMetadata } from "@/shared/utils/message-attachments";
import { readTaskAttachment } from "@/lib/tasks/task-file-storage";

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

  const messages = await db.message.findMany({
    where: { taskId },
    select: { metadata: true },
  });

  const attachment = messages
    .flatMap((message) => getMessageAttachments(normalizeMessageMetadata(message.metadata)))
    .find((entry) => entry.id === attachmentId);

  if (!attachment) {
    return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  }

  const body = await readTaskAttachment(taskId, attachmentId);
  if (!body) {
    return NextResponse.json({ error: "Attachment body missing" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `inline; filename="${attachment.name}"`,
      "Cache-Control": "private, max-age=3600",
    },
  });
}

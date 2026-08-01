import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import { authenticateAgentRequest } from "@/lib/auth/agent-request";
import { db } from "@/lib/db";
import { openTaskAttachmentStreamByStorageKey } from "@/lib/tasks/task-file-storage";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string; attachmentId: string }> },
) {
  const auth = await authenticateAgentRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { taskId, attachmentId } = await params;
  const task = await db.task.findFirst({
    where: {
      id: taskId,
      project: { userId: auth.user.id },
      OR: [
        { executionHost: auth.agentHost },
        { executionHost: null, agentHost: auth.agentHost },
      ],
    },
    select: { id: true },
  });
  if (!task) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  const attachment = await db.taskAttachment.findFirst({
    where: { id: attachmentId, taskId, messageId: { not: null } },
  });
  if (!attachment) return NextResponse.json({ error: "Attachment not found" }, { status: 404 });
  const body = await openTaskAttachmentStreamByStorageKey(taskId, attachment.storageKey);
  if (!body) return NextResponse.json({ error: "Attachment body missing" }, { status: 404 });

  return new NextResponse(Readable.toWeb(body.stream) as ReadableStream, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(body.sizeBytes),
      "Content-Disposition": `attachment; filename="${attachment.originalName}"`,
      "Cache-Control": "private, no-store",
      ETag: `"${attachment.sha256}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

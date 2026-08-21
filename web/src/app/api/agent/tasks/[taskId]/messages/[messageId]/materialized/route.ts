import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authenticateAgentRequest } from "@/lib/auth/agent-request";
import { db } from "@/lib/db";
import { verifyAttachmentTransferToken } from "@/lib/tasks/attachment-transfer-token";

const bodySchema = z.object({
  attachments: z.array(z.object({
    id: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    status: z.literal("ready"),
    transferToken: z.string().min(1),
  })).min(1).max(20),
}).superRefine((value, context) => {
  const ids = value.attachments.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Duplicate attachment IDs" });
  }
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string; messageId: string }> },
) {
  const auth = await authenticateAgentRequest(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { taskId, messageId } = await params;
  if (parsed.data.attachments.some((attachment) => !verifyAttachmentTransferToken(
    attachment.transferToken,
    { taskId, attachmentId: attachment.id, agentHost: auth.agentHost },
  ))) return NextResponse.json({ error: "Not found" }, { status: 404 });
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
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const expected = new Map(parsed.data.attachments.map((entry) => [entry.id, entry.sha256.toLowerCase()]));
  const matching = await db.taskAttachment.findMany({
    where: { id: { in: [...expected.keys()] }, taskId, messageId },
    select: { id: true, sha256: true },
  });
  if (
    matching.length !== expected.size
    || matching.some((entry) => entry.sha256.toLowerCase() !== expected.get(entry.id))
  ) {
    return NextResponse.json({ error: "Attachment verification failed" }, { status: 409 });
  }

  const now = new Date();
  const updated = await db.taskAttachment.updateMany({
    where: { id: { in: [...expected.keys()] }, taskId, messageId },
    data: {
      status: "materialized",
      materializedHost: auth.agentHost,
      materializedAt: now,
    },
  });
  if (updated.count !== expected.size) {
    return NextResponse.json({ error: "Attachment verification failed" }, { status: 409 });
  }
  return NextResponse.json({ status: "ok", materialized_at: now.toISOString() });
}

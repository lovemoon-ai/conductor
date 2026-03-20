import { Buffer } from "node:buffer";
import { NextRequest, NextResponse } from "next/server";

import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { buildMessageResponse, getMessageAttachments } from "@/lib/conductor/message-attachments";
import { writeTaskAttachment } from "@/lib/conductor/task-file-storage";

export const runtime = "nodejs";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const isConductorFireHost = (host: unknown): host is string =>
  typeof host === "string" && host.startsWith("conductor-fire-");

const normalizeMessageRole = (value: unknown): "sdk" | "assistant" | "user" => {
  if (typeof value !== "string") {
    return "sdk";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "assistant" || normalized === "user") {
    return normalized;
  }
  return "sdk";
};

const normalizeOptionalString = (value: FormDataEntryValue | null): string => {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
};

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
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const formData = await request.formData();
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

  const role = normalizeMessageRole(formData.get("role"));
  const content = normalizeOptionalString(formData.get("content"));
  const bytes = Buffer.from(await fileValue.arrayBuffer());
  const attachment = await writeTaskAttachment({
    taskId,
    fileName: fileValue.name,
    bytes,
    mimeType: fileValue.type,
  });
  const metadata = { attachments: [attachment] };

  const message = await db.message.create({
    data: {
      taskId,
      role,
      content: content || `Attached file: ${attachment.name}`,
      metadata: JSON.stringify(metadata),
    },
  });

  realtimeHub.broadcast(user.id, task.projectId, {
    type: role === "user" ? "task_user_message" : "task_sdk_message",
    payload: {
      ...buildMessageResponse(message),
      task_id: message.taskId,
      project_id: task.projectId,
    },
  });

  if (role === "user") {
    const boundAgentHost = realtimeHub.getTaskAgentHost(taskId);
    const boundFireHost = isConductorFireHost(boundAgentHost) ? boundAgentHost : null;
    const runtimeFireHost = isConductorFireHost(task.executionHost) ? task.executionHost : null;
    const fallbackFireHost = isConductorFireHost(task.agentHost) ? task.agentHost : null;
    const targetHost = boundFireHost || runtimeFireHost || fallbackFireHost || null;
    const requestId = message.id;

    await enqueueAndAttemptAgentCommand(
      {
        userId: user.id,
        agentHost: targetHost,
        taskId: task.id,
        eventType: "task_user_message",
        requestId,
        envelope: {
          type: "task_user_message",
          payload: {
            request_id: requestId,
            message_id: message.id,
            task_id: message.taskId,
            project_id: task.projectId,
            role: "user",
            content: message.content,
            created_at: message.createdAt.toISOString(),
            metadata,
            attachments: getMessageAttachments(metadata),
          },
        },
      },
      {
        agentHost: targetHost,
        sendToAgentHost: ({ userId: targetUserId, agentHost: targetAgentHost, envelope }) =>
          realtimeHub.sendToAgentHost(targetUserId, targetAgentHost, envelope),
        resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
      },
    );
  }

  return NextResponse.json(buildMessageResponse(message));
}

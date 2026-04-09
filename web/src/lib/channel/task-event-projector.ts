import { buildMessageResponse } from "@/shared/utils/message-attachments";
import { realtimeHub } from "@/lib/realtime/hub";
import { enqueueProjectedTaskUpdate } from "./outbox";

export async function projectTaskMessage(input: {
  userId: string;
  projectId: string;
  message: {
    id: string;
    taskId: string;
    role: string;
    content: string;
    metadata?: unknown;
    createdAt: Date | string;
  };
}): Promise<void> {
  const normalizedRole = String(input.message.role || "").toLowerCase();
  realtimeHub.broadcast(input.userId, input.projectId, {
    type: normalizedRole === "user" ? "task_user_message" : "task_sdk_message",
    payload: {
      ...buildMessageResponse(input.message),
      task_id: input.message.taskId,
      project_id: input.projectId,
    },
  });

  if (normalizedRole !== "user") {
    await enqueueProjectedTaskUpdate({
      userId: input.userId,
      taskId: input.message.taskId,
      kind: "assistant_message",
      text: input.message.content,
    });
  }
}

export async function projectTaskStatusUpdate(input: {
  userId: string;
  projectId: string;
  taskId: string;
  status: string;
  summary?: string | null;
}): Promise<void> {
  realtimeHub.notifyTaskStatus(input.taskId, input.status);
  realtimeHub.broadcast(input.userId, input.projectId, {
    type: "task_status_update",
    payload: {
      task_id: input.taskId,
      project_id: input.projectId,
      status: input.status,
      summary: input.summary ?? undefined,
    },
  });

  await enqueueProjectedTaskUpdate({
    userId: input.userId,
    taskId: input.taskId,
    kind: "task_status",
    text: `Task ${input.taskId} is now ${input.status}${input.summary ? `: ${input.summary}` : ""}`,
  });
}

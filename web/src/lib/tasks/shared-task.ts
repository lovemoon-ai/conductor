import { db } from "@/lib/db";

export const MAX_SHARED_MESSAGES = 500;

export interface SharedTaskPayload {
  task: {
    id: string;
    title: string;
    status: string;
    taskType: string;
    createdAt: string;
    expiresAt: string | null;
  };
  messages: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: string;
  }>;
}

export type SharedTaskLookupResult =
  | { status: "not_found" }
  | { status: "expired" }
  | { status: "ok"; data: SharedTaskPayload };

export async function loadSharedTask(token: string): Promise<SharedTaskLookupResult> {
  const shared = await db.sharedTask.findUnique({
    where: { token },
    include: {
      task: true,
    },
  });

  if (!shared) {
    return { status: "not_found" };
  }

  if (shared.expiresAt && shared.expiresAt.getTime() <= Date.now()) {
    await db.sharedTask.delete({
      where: { id: shared.id },
    }).catch(() => null);
    return { status: "expired" };
  }

  const rawMessages = await db.message.findMany({
    where: { taskId: shared.task.id, role: { in: ["user", "assistant", "sdk"] } },
    orderBy: { createdAt: "asc" },
    take: MAX_SHARED_MESSAGES,
    select: { id: true, role: true, content: true, metadata: true, createdAt: true },
  });

  const messages = rawMessages.filter((msg) => {
    if (!msg.metadata) return true;
    try {
      const meta = typeof msg.metadata === "string" ? JSON.parse(msg.metadata) : msg.metadata;
      return !meta?.synthetic;
    } catch {
      return true;
    }
  });

  return {
    status: "ok",
    data: {
      task: {
        id: shared.task.id,
        title: shared.task.title,
        status: shared.task.status,
        taskType: shared.task.taskType,
        createdAt: shared.task.createdAt.toISOString(),
        expiresAt: shared.expiresAt?.toISOString() ?? null,
      },
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
      })),
    },
  };
}

export function buildSharedPlainText(payload: SharedTaskPayload): string {
  const header = [
    `Title: ${payload.task.title}`,
    `Created: ${new Date(payload.task.createdAt).toISOString()}`,
    payload.task.expiresAt ? `Share Expires: ${new Date(payload.task.expiresAt).toISOString()}` : null,
    "",
    "Conversation:",
  ].filter(Boolean);

  const body = payload.messages.map((message) => {
    const roleLabel =
      message.role === "user" ? "User"
      : message.role === "assistant" ? "Assistant"
      : "System";
    return `${roleLabel}: ${message.content.trim()}`;
  });

  return [...header, ...body].join("\n\n").trim();
}

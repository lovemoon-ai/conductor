import { randomBytes } from "crypto";
import { db } from "@/lib/db";

export const MAX_SHARED_MESSAGES = 500;

export const SHARED_TASK_KIND_USER = "user";
export const SHARED_TASK_KIND_RESUME_HANDOFF = "resume_handoff";

// Internal resume-handoff shares have a much shorter TTL than user shares:
// a successor backend should fetch the transcript within minutes of being
// spawned, and we do not want to retain effectively-public URLs any longer
// than necessary.
const RESUME_HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Single source of truth for share-token generation. Both user-facing share
 * links (`/api/tasks/[taskId]/share`) and internal resume-handoff links
 * (`createInternalResumeHandoffShare`) must mint tokens the same way so the
 * entropy budget cannot drift between callers.
 *
 * 16 bytes → 22-char base64url ≈ 128 bits of entropy. The token is the only
 * access credential for `/share/<token>/plain`; do not reduce.
 */
export function generateShareToken(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Create (or refresh) a short-lived share link that a successor AI backend
 * can fetch at `/share/{token}/plain` to catch up on the prior conversation.
 * This replaces low-level JSONL session translation: instead of rewriting
 * the source backend's session file into the target's native format, we
 * hand the target a URL it can pull as plain-text context.
 */
export async function createInternalResumeHandoffShare(params: {
  taskId: string;
  ownerUserId: string;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + RESUME_HANDOFF_TTL_MS);

  // Clean up any previously-expired internal share for this task+user so the
  // upsert below never hits a stale unique-constraint row.
  await db.sharedTask.deleteMany({
    where: {
      taskId: params.taskId,
      userId: params.ownerUserId,
      kind: SHARED_TASK_KIND_RESUME_HANDOFF,
      expiresAt: { lte: now },
    },
  });

  const shared = await db.sharedTask.upsert({
    where: {
      taskId_userId_kind: {
        taskId: params.taskId,
        userId: params.ownerUserId,
        kind: SHARED_TASK_KIND_RESUME_HANDOFF,
      },
    },
    update: {
      expiresAt,
      // Rotate the token every time we refresh, so a leaked handoff URL from a
      // previous restart cannot be reused indefinitely.
      token: generateShareToken(),
    },
    create: {
      taskId: params.taskId,
      userId: params.ownerUserId,
      kind: SHARED_TASK_KIND_RESUME_HANDOFF,
      token: generateShareToken(),
      expiresAt,
    },
  });

  return {
    token: shared.token,
    expiresAt: shared.expiresAt ?? expiresAt,
  };
}

export function buildResumeHandoffUrl(baseUrl: string, token: string): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  return `${trimmed}/share/${encodeURIComponent(token)}/plain`;
}

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

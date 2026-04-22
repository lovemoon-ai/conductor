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

// If a previous handoff token for the same (task, user) still has at least
// this much life left, reuse it instead of rotating. Rotating a token that
// just shipped inside an outbox event would invalidate the URL the
// not-yet-spawned successor is about to fetch — a real race on double-click
// restarts. Reuse inside the freshness window keeps that window small for
// the attacker while keeping double-click behavior correct.
const RESUME_HANDOFF_REUSE_WINDOW_MS = 12 * 60 * 60 * 1000;

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
 *
 * Token rotation policy: we rotate the token on every restart *unless* the
 * existing token is still reasonably fresh (>= RESUME_HANDOFF_REUSE_WINDOW_MS
 * remaining). Reusing inside the freshness window avoids a race where a
 * double-click restart invalidates the URL that the first restart's outbox
 * event is about to deliver.
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

  const existing = await db.sharedTask.findUnique({
    where: {
      taskId_userId_kind: {
        taskId: params.taskId,
        userId: params.ownerUserId,
        kind: SHARED_TASK_KIND_RESUME_HANDOFF,
      },
    },
  });

  const existingRemainingMs =
    existing?.expiresAt ? existing.expiresAt.getTime() - now.getTime() : 0;
  const shouldReuseExistingToken =
    Boolean(existing) && existingRemainingMs >= RESUME_HANDOFF_REUSE_WINDOW_MS;

  const shared = await db.sharedTask.upsert({
    where: {
      taskId_userId_kind: {
        taskId: params.taskId,
        userId: params.ownerUserId,
        kind: SHARED_TASK_KIND_RESUME_HANDOFF,
      },
    },
    update: shouldReuseExistingToken
      ? { expiresAt }
      : {
          expiresAt,
          // Rotate the token when it is close to expiry, so a leaked
          // handoff URL does not live indefinitely across many restarts.
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
  // Strip ALL trailing slashes so a misconfigured env var like
  // `https://host/` or `https://host///` still yields a clean URL.
  const trimmed = baseUrl.replace(/\/+$/, "");
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

// Fence markers wrap the conversation body so a consumer (human or AI) can
// tell where untrusted historical content starts and ends. The strings are
// deliberately distinctive so they rarely collide with real prose; any
// occurrence INSIDE a message is neutralized (see stripTranscriptFenceTokens)
// to prevent a malicious user from "closing" the fence early and injecting
// post-fence instructions that a cross-backend resume might otherwise honor.
export const TRANSCRIPT_FENCE_BEGIN = "<<<CONDUCTOR_TRANSCRIPT_BEGIN>>>";
export const TRANSCRIPT_FENCE_END = "<<<CONDUCTOR_TRANSCRIPT_END>>>";

function stripTranscriptFenceTokens(input: string): string {
  // Preserve the surrounding text but break up the marker so it cannot be
  // mistaken for a real fence delimiter by a downstream parser or LLM.
  return input
    .replace(/<<<CONDUCTOR_TRANSCRIPT_BEGIN>>>/g, "<<<CONDUCTOR_TRANSCRIPT_BEGIN_>>>")
    .replace(/<<<CONDUCTOR_TRANSCRIPT_END>>>/g, "<<<CONDUCTOR_TRANSCRIPT_END_>>>");
}

export function buildSharedPlainText(payload: SharedTaskPayload): string {
  const header = [
    `Title: ${payload.task.title}`,
    `Created: ${new Date(payload.task.createdAt).toISOString()}`,
    payload.task.expiresAt ? `Share Expires: ${new Date(payload.task.expiresAt).toISOString()}` : null,
    "",
    "Conversation:",
    TRANSCRIPT_FENCE_BEGIN,
  ].filter(Boolean);

  const body = payload.messages.map((message) => {
    const roleLabel =
      message.role === "user" ? "User"
      : message.role === "assistant" ? "Assistant"
      : "System";
    return `${roleLabel}: ${stripTranscriptFenceTokens(message.content.trim())}`;
  });

  return [...header, ...body, TRANSCRIPT_FENCE_END].join("\n\n").trim();
}

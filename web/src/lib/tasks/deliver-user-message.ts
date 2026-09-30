import {
  appendUserMessageToTask,
  TaskIngressError,
} from "@/lib/channel/task-ingress-service";
import { db } from "@/lib/db";
import { startPersistentRound } from "@/lib/tasks/persistent-round";
import { normalizeTaskStatus, parseJsonObject } from "@/lib/tasks/task-config";
import { readPersistentTaskState } from "@/shared/utils/persistent-task";

/**
 * Server-side send rules for a `user` message, so every client (web, CLI, SDK,
 * scheduler, IM channel) gets the behaviour the web composer enforces.
 */

type AppendInput = Parameters<typeof appendUserMessageToTask>[0];
type StoredMessage = Awaited<ReturnType<typeof appendUserMessageToTask>>["message"];

// A persistent round whose session is gone is idle: the next message starts a new round.
const ROUND_IDLE_STATUSES = new Set(["completed", "killed", "unknown"]);
// A message to these tasks is never read by a fire.
const NOT_RUNNING_STATUSES = new Set(["completed", "killed", "killing"]);
// Matches the restart route's refresh_session ack timeout.
const SESSION_REFRESH_WINDOW_MS = 60_000;

const conflict = (code: string, error: string, message: string) =>
  new TaskIngressError(code, 409, message, { error, message });

/** The AI has not finished answering the end-of-round summary request yet. */
async function isRoundSummaryPending(taskId: string, roundEndMessageId: string): Promise<boolean> {
  const runtime = await db.taskRuntimeState.findUnique({
    where: { taskId },
    select: { replyInProgress: true, replyTo: true },
  });
  if (runtime?.replyInProgress && runtime.replyTo === roundEndMessageId) return true;
  const replies = await db.message.findMany({
    where: { taskId, role: { not: "user" }, metadata: { contains: roundEndMessageId } },
    select: { metadata: true },
  });
  return !replies.some((reply) => parseJsonObject(reply.metadata)?.reply_to === roundEndMessageId);
}

/** A refresh_session command is still waiting for the daemon's ack. */
export async function assertNoSessionRefreshPending(taskId: string): Promise<void> {
  const refresh = await db.agentOutbox.findFirst({
    where: {
      taskId,
      eventType: "refresh_session",
      status: { in: ["pending", "sent"] },
      createdAt: { gt: new Date(Date.now() - SESSION_REFRESH_WINDOW_MS) },
    },
    select: { requestId: true },
  });
  if (refresh) {
    throw conflict("RESTART_PENDING", "restart_pending", "Wait for the task restart to finish before sending another message.");
  }
}

/**
 * Applies the persistent-round rules (RFC 0039) to a user message: while the
 * end-of-round summary is pending it is rejected; when the round is idle it
 * starts the next round and the new round's first message is returned.
 * Returns null when the message belongs to the current round.
 */
export async function startRoundIfPersistentIdle(input: {
  userId: string;
  task: { id: string; status?: string | null; metadata?: string | null };
  content: string;
  metadata?: Record<string, unknown> | null;
  attachmentIds?: string[];
}): Promise<StoredMessage | null> {
  const state = readPersistentTaskState(parseJsonObject(input.task.metadata));
  if (!state?.enabled) return null;
  const status = normalizeTaskStatus(input.task.status);
  if (
    state.roundEndMessageId &&
    status === "running" &&
    (await isRoundSummaryPending(input.task.id, state.roundEndMessageId))
  ) {
    throw conflict(
      "ROUND_SUMMARY_PENDING",
      "round_summary_pending",
      "The AI is still writing the end-of-round summary. Send again once it finishes.",
    );
  }
  if (!state.roundEndedAt && !ROUND_IDLE_STATUSES.has(status)) return null;
  if (input.attachmentIds?.length) {
    const message = "Start the new round with a text message, then attach files.";
    throw new TaskIngressError("ROUND_START_REQUIRES_TEXT", 409, message, { error: message });
  }
  const result = await startPersistentRound({
    userId: input.userId,
    taskId: input.task.id,
    content: input.content,
    messageMetadata: input.metadata,
  });
  if (!result.ok) {
    throw new TaskIngressError("ROUND_START_FAILED", result.status, result.error, result.details ?? { error: result.error });
  }
  return db.message.findUniqueOrThrow({ where: { id: result.messageId! } });
}

/** appendUserMessageToTask plus the send rules above; non-user messages pass straight through. */
export async function deliverUserMessage(input: AppendInput): Promise<StoredMessage> {
  if (String(input.role ?? "sdk").trim().toLowerCase() === "user") {
    const task = await db.task.findFirst({
      where: { id: input.taskId, project: { userId: input.userId } },
      select: { id: true, status: true, metadata: true, achievedAt: true },
    });
    // Missing and archived tasks get their errors from appendUserMessageToTask.
    if (task && !task.achievedAt) {
      const roundMessage = await startRoundIfPersistentIdle({ ...input, task });
      if (roundMessage) return roundMessage;
      if (NOT_RUNNING_STATUSES.has(normalizeTaskStatus(task.status))) {
        throw conflict("TASK_NOT_RUNNING", "task_not_running", "Only running ai_task accepts new messages");
      }
      await assertNoSessionRefreshPending(task.id);
    }
  }
  return (await appendUserMessageToTask(input)).message;
}

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import {
  TaskIngressError,
  appendUserMessageToTask,
} from "@/lib/channel/task-ingress-service";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { resolveFireTaskRouting } from "@/lib/tasks/fire-routing";
import { normalizeTaskStatus, normalizeOptionalString } from "@/lib/tasks/task-config";
import { buildMessageResponse } from "@/shared/utils/message-attachments";
import { stripTopLevelAuditKeys } from "@/lib/audit/metadata";

const INSERT_ACK_TIMEOUT_MS = 2500;

/**
 * Insert a mid-turn message into a running ai_task.
 *
 * This is additive on top of the normal message path. A normal POST
 * /messages queues the message and the agent only picks it up after the
 * current turn finishes. An insert instead:
 *   1. persists + delivers the user message (same as a normal user message), and
 *   2. interrupts the in-flight turn (reason: "user_insert") so the fire host's
 *      poll loop immediately drains the just-inserted message as the next turn.
 *
 * The interrupt reuses the existing `interrupt_turn` envelope, so no new fire
 * host command is required. The fire host suppresses the "Conversation
 * interrupted" confirmation when the reason is "user_insert" to keep the
 * insertion seamless.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) {
    return userResult;
  }
  const user = userResult;

  const [{ taskId }, body] = await Promise.all([
    params,
    request.json().catch(() => ({})),
  ]);

  const content = typeof body?.content === "string" ? body.content : "";
  if (!content) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  const requestedReplyTo = normalizeOptionalString(body?.target_reply_to ?? body?.targetReplyTo);
  const clientMessageId = normalizeOptionalString(body?.client_message_id ?? body?.clientMessageId);
  const rawCallerMetadata: Record<string, unknown> | null =
    body?.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
      ? (body.metadata as Record<string, unknown>)
      : null;
  const callerMetadata = stripTopLevelAuditKeys(rawCallerMetadata);

  const task = await db.task.findFirst({
    where: {
      id: taskId,
      project: { userId: user.id },
    },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      status: true,
      agentHost: true,
      executionHost: true,
      metadata: true,
      project: {
        select: {
          daemonHost: true,
        },
      },
    },
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((task.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json(
      { error: "task_type_not_insertable", message: "pty_task does not support message insertion" },
      { status: 409 },
    );
  }
  if (normalizeTaskStatus(task.status) !== "running") {
    return NextResponse.json(
      { error: "task_not_running", message: "Only running ai_task supports message insertion" },
      { status: 409 },
    );
  }

  // Resolve the in-flight turn's reply target BEFORE persisting the new message,
  // so we interrupt the turn that is currently being answered (the most recent
  // pre-existing user message) rather than the message we are about to insert.
  let targetReplyTo = requestedReplyTo;
  if (!targetReplyTo) {
    const latestUserMessage = await db.message.findFirst({
      where: { taskId, role: "user" },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    targetReplyTo = normalizeOptionalString(latestUserMessage?.id);
  }

  // Persist + deliver the inserted user message through the normal ingress path
  // (durable outbox + websocket scope). It is tagged so downstream consumers can
  // tell an inserted message apart from an ordinary user message.
  let message;
  try {
    ({ message } = await appendUserMessageToTask({
      userId: user.id,
      taskId,
      content,
      role: "user",
      clientMessageId,
      metadata: { ...(callerMetadata ?? {}), insert: true },
    }));
  } catch (error) {
    if (error instanceof TaskIngressError) {
      return NextResponse.json(error.details ?? { error: error.message }, { status: error.status });
    }
    throw error;
  }

  // If we could not determine the in-flight turn, the message has still been
  // delivered and will run after the current turn completes (the existing
  // queue-after-turn behavior). Report it as a non-interrupting delivery.
  if (!targetReplyTo) {
    return NextResponse.json({
      delivered: true,
      interrupted: false,
      task_id: taskId,
      message_id: message.id,
      message: buildMessageResponse(message),
    });
  }

  const boundAgentHost = normalizeOptionalString(realtimeHub.getTaskAgentHost(taskId));
  const routing = resolveFireTaskRouting(task, boundAgentHost);
  if (!routing.fireOwnerHost) {
    // Message already delivered; we just couldn't interrupt the running turn.
    return NextResponse.json({
      delivered: true,
      interrupted: false,
      task_id: taskId,
      message_id: message.id,
      message: buildMessageResponse(message),
      task_model: routing.taskModel,
      daemon_host: routing.daemonAssociationHost,
    });
  }

  const requestId = randomUUID();
  const envelope = {
    type: "interrupt_turn",
    payload: {
      task_id: taskId,
      project_id: task.projectId,
      request_id: requestId,
      target_reply_to: targetReplyTo,
      reason: "user_insert",
    },
  };
  const deliveredHosts = routing.fireOwnerCandidates.filter((host) =>
    realtimeHub.sendToAgentHost(user.id, host, envelope),
  );
  const acked =
    deliveredHosts.length > 0
      ? await realtimeHub.waitForAgentCommandAck(taskId, requestId, INSERT_ACK_TIMEOUT_MS, {
          expectedHosts: deliveredHosts,
          eventType: "interrupt_turn",
        })
      : false;

  return NextResponse.json({
    delivered: true,
    interrupted: acked === true,
    task_id: taskId,
    message_id: message.id,
    message: buildMessageResponse(message),
    request_id: requestId,
    target_reply_to: targetReplyTo,
    agent_host: deliveredHosts.length === 1 ? deliveredHosts[0] : null,
    agent_hosts: deliveredHosts,
    task_model: routing.taskModel,
    daemon_host: routing.daemonAssociationHost,
  });
}

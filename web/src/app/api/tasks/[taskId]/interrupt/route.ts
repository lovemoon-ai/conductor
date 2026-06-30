import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { resolveFireTaskRouting } from "@/lib/tasks/fire-routing";
import { normalizeTaskStatus, normalizeOptionalString } from "@/lib/tasks/task-config";

const INTERRUPT_ACK_TIMEOUT_MS = 2500;

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
  const targetReplyTo = normalizeOptionalString(body?.target_reply_to ?? body?.targetReplyTo);
  if (!targetReplyTo) {
    return NextResponse.json({ error: "target_reply_to required" }, { status: 400 });
  }

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
      { error: "task_type_not_interruptible", message: "pty_task does not support turn interruption" },
      { status: 409 },
    );
  }
  if (normalizeTaskStatus(task.status) !== "running") {
    return NextResponse.json(
      { error: "task_not_running", message: "Only running ai_task supports turn interruption" },
      { status: 409 },
    );
  }

  const boundAgentHost = normalizeOptionalString(realtimeHub.getTaskAgentHost(taskId));
  const routing = resolveFireTaskRouting(task, boundAgentHost);
  if (!routing.fireOwnerHost) {
    return NextResponse.json(
      {
        error: "Task missing active fire owner",
        task_model: routing.taskModel,
        daemon_host: routing.daemonAssociationHost,
      },
      { status: 409 },
    );
  }

  const requestId = randomUUID();
  const envelope = {
    type: "interrupt_turn",
    payload: {
      task_id: taskId,
      project_id: task.projectId,
      request_id: requestId,
      target_reply_to: targetReplyTo,
      reason: "user_interrupt",
    },
  };
  const deliveredHosts = routing.fireOwnerCandidates.filter((host) =>
    realtimeHub.sendToAgentHost(user.id, host, envelope),
  );
  if (deliveredHosts.length === 0) {
    return NextResponse.json(
      {
        error: `Task fire owner ${routing.fireOwnerHost} is offline`,
        task_model: routing.taskModel,
        daemon_host: routing.daemonAssociationHost,
      },
      { status: 409 },
    );
  }
  const acked = await realtimeHub.waitForAgentCommandAck(taskId, requestId, INTERRUPT_ACK_TIMEOUT_MS, {
    expectedHosts: deliveredHosts,
    eventType: "interrupt_turn",
  });
  if (acked !== true) {
    return NextResponse.json(
      {
        error:
          acked === false
            ? "Task fire owner rejected interrupt request"
            : "Task fire owner did not acknowledge interrupt request",
        task_model: routing.taskModel,
        daemon_host: routing.daemonAssociationHost,
        agent_hosts: deliveredHosts,
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    delivered: true,
    task_id: taskId,
    request_id: requestId,
    target_reply_to: targetReplyTo,
    agent_host: deliveredHosts.length === 1 ? deliveredHosts[0] : null,
    agent_hosts: deliveredHosts,
    task_model: routing.taskModel,
    daemon_host: routing.daemonAssociationHost,
  });
}

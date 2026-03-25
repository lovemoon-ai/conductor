import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deliverAgentOutboxForHost } from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  normalizeOptionalString,
  parseJsonObject,
} from "@/lib/tasks/task-config";
import { normalizeBackendType } from "@/lib/tasks/pty-runtime";
import {
  countActiveTaskBuckets,
  exceedsTaskLimit,
  getTaskLimitMessage,
  getTaskPlanBucket,
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import {
  canCreateSuccessorTask,
  canInplaceRestart,
  normalizeRestartStrategy,
  RESTARTABLE_SOURCE_STATUSES,
  VALID_RESTART_BACKENDS,
} from "@/lib/tasks/restart";

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

const serializeTaskResponse = (task: {
  id: string;
  projectId: string;
  title: string;
  taskType?: string | null;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  launchConfig?: unknown;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
}) => ({
  id: task.id,
  project_id: task.projectId,
  title: task.title,
  task_type: task.taskType ?? "ai_task",
  status: normalizeTaskStatus(task.status),
  agent_host: task.agentHost,
  execution_host: task.executionHost,
  backend_type: task.backendType,
  session_id: task.sessionId,
  session_file_path: task.sessionFilePath,
  launch_config: parseJsonObject(task.launchConfig),
  metadata: parseJsonObject(task.metadata),
  pty_session: null,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
});

const appendBackendSuffix = (title: string, backend: string): string => `${title} [${backend}]`;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> },
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const body = await request.json().catch(() => null);
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const sourceTask = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
  });
  if (!sourceTask) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ((sourceTask.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json({ error: "Only ai_task supports restart" }, { status: 409 });
  }

  const sourceBackend = normalizeBackendType(sourceTask.backendType);
  if (!sourceBackend) {
    return NextResponse.json({ error: "Task missing backend binding" }, { status: 409 });
  }

  const sourceSessionId = normalizeOptionalString(sourceTask.sessionId);
  if (!sourceSessionId) {
    return NextResponse.json({ error: "Task missing session binding" }, { status: 409 });
  }

  const sourceStatus = normalizeTaskStatus(sourceTask.status);
  if (!RESTARTABLE_SOURCE_STATUSES.has(sourceStatus as any)) {
    return NextResponse.json({ error: "Only running or stopped ai_task can restart" }, { status: 409 });
  }

  const sourceAgentHost = normalizeOptionalString(sourceTask.agentHost);
  if (!sourceAgentHost) {
    return NextResponse.json({ error: "Task missing source daemon binding" }, { status: 409 });
  }
  if (isConductorFireHost(sourceAgentHost)) {
    return NextResponse.json({ error: "manual fire task does not support in-app restart yet" }, { status: 409 });
  }

  const connectedAgents = realtimeHub.getAgentsForUser(user.id);
  const sourceAgent = connectedAgents.find((agent) => agent.host === sourceAgentHost) ?? null;
  if (!sourceAgent) {
    return NextResponse.json({ error: `Source daemon ${sourceAgentHost} is offline` }, { status: 409 });
  }

  const hasExplicitBackendTarget =
    Object.prototype.hasOwnProperty.call(normalizedBody, "backend_type") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "backendType");
  const requestedBackend =
    normalizeBackendType(normalizedBody.backend_type ?? normalizedBody.backendType);
  if (hasExplicitBackendTarget && (!requestedBackend || !VALID_RESTART_BACKENDS.has(requestedBackend))) {
    return NextResponse.json({ error: "invalid backend_type" }, { status: 400 });
  }
  const targetBackend = requestedBackend ?? sourceBackend;
  const requestedStrategy = normalizeRestartStrategy(normalizedBody.strategy ?? normalizedBody.restart_strategy);
  const hasExplicitStrategy =
    Object.prototype.hasOwnProperty.call(normalizedBody, "strategy") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "restart_strategy");
  if (hasExplicitStrategy && !requestedStrategy) {
    return NextResponse.json({ error: "invalid strategy" }, { status: 400 });
  }
  const supportedBackends = Array.isArray(sourceAgent.supportedBackends) ? sourceAgent.supportedBackends : [];
  if (!supportedBackends.includes(targetBackend)) {
    return NextResponse.json(
      { error: `Daemon ${sourceAgentHost} does not support backend ${targetBackend}` },
      { status: 409 },
    );
  }

  const strategy =
    requestedStrategy ??
    (canInplaceRestart(sourceStatus, sourceBackend, targetBackend) ? "inplace" : "new_task");
  const isBackendSwitch = targetBackend !== sourceBackend;
  const isInplaceRestart = strategy === "inplace";

  if (isInplaceRestart && !canInplaceRestart(sourceStatus, sourceBackend, targetBackend)) {
    return NextResponse.json(
      { error: "In-place restart requires a stopped task on the current backend" },
      { status: 409 },
    );
  }

  if (!isInplaceRestart && !canCreateSuccessorTask(sourceBackend, targetBackend)) {
    return NextResponse.json(
      { error: `Backend switch ${sourceBackend} -> ${targetBackend} is not supported` },
      { status: 409 },
    );
  }

  if (!isInplaceRestart) {
    const planUser = await db.user.findUnique({
      where: { id: user.id },
      select: { subscriptionTier: true },
    });
    if (!planUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const activeTasks = await db.task.findMany({
      where: { project: { userId: user.id } },
      select: {
        id: true,
        projectId: true,
        status: true,
        agentHost: true,
        executionHost: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    const activeTaskCounts = countActiveTaskBuckets(activeTasks);
    const taskBucket = getTaskPlanBucket(sourceAgentHost);
    if (exceedsTaskLimit(planUser.subscriptionTier, taskBucket, activeTaskCounts)) {
      return NextResponse.json(
        {
          error: "Task limit reached",
          message: getTaskLimitMessage(planUser.subscriptionTier, taskBucket),
          limit_type: taskBucket === "manual_fire" ? "manual_fire_active_task" : "app_active_task",
        },
        { status: 403 },
      );
    }
  }

  const requestId = randomUUID();
  const now = new Date();

  if (isInplaceRestart) {
    const updatedTask = await db.$transaction(async (tx) => {
      await tx.agentOutbox.create({
        data: {
          userId: user.id,
          agentHost: sourceAgentHost,
          taskId: sourceTask.id,
          eventType: "restart_task",
          requestId,
          payloadJson: JSON.stringify({
            type: "restart_task",
            payload: {
              mode: "resume_inplace",
              source_task_id: sourceTask.id,
              target_task_id: sourceTask.id,
              project_id: sourceTask.projectId,
              title: sourceTask.title,
              source_backend_type: sourceBackend,
              source_session_id: sourceSessionId,
              source_session_file_path: sourceTask.sessionFilePath ?? undefined,
              target_backend_type: targetBackend,
              request_id: requestId,
            },
          }),
          status: "pending",
          attemptCount: 0,
          nextRetryAt: null,
        },
      });

      return tx.task.update({
        where: { id: sourceTask.id },
        data: {
          status: "unknown",
          executionHost: null,
          agentHost: sourceAgentHost,
          updatedAt: now,
        },
      });
    });

    realtimeHub.bindTaskToAgent(sourceTask.id, sourceAgentHost);
    await deliverAgentOutboxForHost({
      userId: user.id,
      agentHost: sourceAgentHost,
      sendToAgentHost: ({ userId: targetUserId, agentHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, agentHost, envelope),
      resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
    }).catch(() => {});

    return NextResponse.json({
      mode: "inplace_restart",
      source_task_id: sourceTask.id,
      task: serializeTaskResponse(updatedTask),
    });
  }

  const successorTaskId = randomUUID();
  const successorTitle = appendBackendSuffix(sourceTask.title, targetBackend);
  const sourceMetadata = parseJsonObject(sourceTask.metadata) ?? {};
  const successorMetadata = {
    continuedFromTaskId: sourceTask.id,
    restartSourceBackendType: sourceBackend,
    restartStrategy: "new_task",
  };

  const createdTask = await db.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        id: successorTaskId,
        projectId: sourceTask.projectId,
        title: successorTitle,
        taskType: "ai_task",
        status: "unknown",
        agentHost: sourceAgentHost,
        executionHost: null,
        backendType: targetBackend,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: JSON.stringify(successorMetadata),
      },
    });

    await tx.task.update({
      where: { id: sourceTask.id },
      data: {
        metadata: JSON.stringify({
          ...sourceMetadata,
          successorTaskId,
          restartRequestId: requestId,
          ...(isBackendSwitch ? { backendSwitchRequestId: requestId } : {}),
        }),
      },
    });

    await tx.agentOutbox.create({
      data: {
        userId: user.id,
        agentHost: sourceAgentHost,
        taskId: successorTaskId,
        eventType: "restart_task",
        requestId,
          payloadJson: JSON.stringify({
            type: "restart_task",
            payload: {
              mode: "fork_to_new_task",
              source_task_id: sourceTask.id,
              target_task_id: successorTaskId,
              project_id: sourceTask.projectId,
            title: successorTitle,
            source_backend_type: sourceBackend,
            source_session_id: sourceSessionId,
            source_session_file_path: sourceTask.sessionFilePath ?? undefined,
            target_backend_type: targetBackend,
            request_id: requestId,
          },
        }),
        status: "pending",
        attemptCount: 0,
        nextRetryAt: null,
      },
    });

    return task;
  });

  realtimeHub.bindTaskToAgent(successorTaskId, sourceAgentHost);
  await deliverAgentOutboxForHost({
    userId: user.id,
    agentHost: sourceAgentHost,
    sendToAgentHost: ({ userId: targetUserId, agentHost, envelope }) =>
      realtimeHub.sendToAgentHost(targetUserId, agentHost, envelope),
    resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
  }).catch(() => {});

  return NextResponse.json({
    mode: isBackendSwitch ? "backend_switch_new_task" : "successor_new_task",
    source_task_id: sourceTask.id,
    task: serializeTaskResponse(createdTask),
  });
}

import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { buildTaskDiagnosticsPayload } from "@/lib/diagnostics/task-diagnostics";
import { realtimeHub } from "@/lib/realtime/hub";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { buildMessageResponse } from "@/lib/conductor/message-attachments";
import { deleteTaskAttachmentDirectory } from "@/lib/conductor/task-file-storage";
import {
  normalizeOptionalString,
  normalizeTaskType,
  parseJsonObject,
  parseTaskType,
  type JsonObject,
} from "@/lib/tasks/task-config";
import {
  applyLegacyTaskShape,
  isMissingPtySchemaError,
  legacyTaskSelect,
  PTY_SCHEMA_UNAVAILABLE_MESSAGE,
  withPtySchemaFallback,
} from "@/lib/tasks/pty-compat";
import {
  buildPtySessionConfigPatch,
  buildPtySessionCreateSeed,
  buildPtySessionRestartPatch,
  dispatchPtyTaskCreation,
  normalizeBackendType,
  resolvePtyAgentHost,
  validatePtyLaunchConfig,
  type ConnectedAgent,
} from "@/lib/tasks/pty-runtime";

const DELETE_SNAPSHOT_TRIGGER = "task_delete";
const STOP_TASK_ACK_TIMEOUT_MS = 2500;
const STOP_TASK_FINAL_STATUS_TIMEOUT_MS = 5000;

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

const normalizeHost = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const readPatchField = (
  payload: Record<string, any>,
  snakeCaseKey: string,
  camelCaseKey: string
): unknown => {
  if (Object.prototype.hasOwnProperty.call(payload, snakeCaseKey)) {
    return payload[snakeCaseKey];
  }
  if (Object.prototype.hasOwnProperty.call(payload, camelCaseKey)) {
    return payload[camelCaseKey];
  }
  return undefined;
};

const serializePtySession = (ptySession: {
  id: string;
  taskId: string;
  state: string;
  entrypointType: string | null;
  toolPreset: string | null;
  commandJson: string | null;
  cwd: string | null;
  envJson: string | null;
  shell: string | null;
  pid: number | null;
  cols: number | null;
  rows: number | null;
  lastOutputSeq: number;
  startedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
} | null) =>
  ptySession
    ? {
        id: ptySession.id,
        task_id: ptySession.taskId,
        state: ptySession.state,
        entrypoint_type: ptySession.entrypointType,
        tool_preset: ptySession.toolPreset,
        command: parseJsonObject(ptySession.commandJson),
        cwd: ptySession.cwd,
        env: parseJsonObject(ptySession.envJson),
        shell: ptySession.shell,
        pid: ptySession.pid,
        cols: ptySession.cols,
        rows: ptySession.rows,
        last_output_seq: ptySession.lastOutputSeq,
        started_at: ptySession.startedAt?.toISOString() ?? null,
        closed_at: ptySession.closedAt?.toISOString() ?? null,
        created_at: ptySession.createdAt.toISOString(),
        updated_at: ptySession.updatedAt.toISOString(),
      }
    : null;

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
  ptySession?: Parameters<typeof serializePtySession>[0];
}) => ({
  id: task.id,
  project_id: task.projectId,
  title: task.title,
  task_type: normalizeTaskType(task.taskType),
  status: normalizeTaskStatus(task.status),
  agent_host: task.agentHost,
  execution_host: task.executionHost,
  backend_type: task.backendType,
  session_id: task.sessionId,
  session_file_path: task.sessionFilePath,
  launch_config: parseJsonObject(task.launchConfig),
  metadata: parseJsonObject(task.metadata),
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
  pty_session: serializePtySession(task.ptySession ?? null),
});

const findTaskDetail = async (userId: string, taskId: string) =>
  withPtySchemaFallback(
    "tasks.taskId.GET",
    () =>
      db.task.findFirst({
        where: { id: taskId, project: { userId } },
        include: {
          messages: { orderBy: { createdAt: "asc" } },
          ptySession: true,
        },
      }),
    async () => {
      const task = await db.task.findFirst({
        where: { id: taskId, project: { userId } },
        select: legacyTaskSelect,
      });
      if (!task) return null;
      const messages = await db.message.findMany({
        where: { taskId },
        orderBy: { createdAt: "asc" },
      });
      return {
        ...applyLegacyTaskShape(task),
        messages,
      };
    },
  );

const findTaskForPatch = async (userId: string, taskId: string) =>
  withPtySchemaFallback(
    "tasks.taskId.PATCH.findExisting",
    () =>
      db.task.findFirst({
        where: { id: taskId, project: { userId } },
        include: {
          ptySession: true,
        },
      }),
    async () => {
      const task = await db.task.findFirst({
        where: { id: taskId, project: { userId } },
        select: legacyTaskSelect,
      });
      return task ? applyLegacyTaskShape(task) : null;
    },
  );

const buildTaskRollbackData = (task: {
  projectId: string;
  title: string;
  taskType?: string | null;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  launchConfig?: string | null;
  metadata: string | null;
}) => ({
  projectId: task.projectId,
  title: task.title,
  taskType: task.taskType ?? "ai_task",
  status: task.status,
  agentHost: task.agentHost,
  executionHost: task.executionHost,
  backendType: task.backendType,
  sessionId: task.sessionId,
  sessionFilePath: task.sessionFilePath,
  launchConfig: task.launchConfig ?? null,
  metadata: task.metadata,
});

const buildPtySessionRollbackWrite = (ptySession: {
  taskId: string;
  state: string;
  entrypointType: string | null;
  toolPreset: string | null;
  commandJson: string | null;
  cwd: string | null;
  envJson: string | null;
  shell: string | null;
  pid: number | null;
  cols: number | null;
  rows: number | null;
  lastOutputSeq: number;
  startedAt: Date | null;
  closedAt: Date | null;
}) => ({
  taskId: ptySession.taskId,
  state: ptySession.state,
  entrypointType: ptySession.entrypointType,
  toolPreset: ptySession.toolPreset,
  commandJson: ptySession.commandJson,
  cwd: ptySession.cwd,
  envJson: ptySession.envJson,
  shell: ptySession.shell,
  pid: ptySession.pid,
  cols: ptySession.cols,
  rows: ptySession.rows,
  lastOutputSeq: ptySession.lastOutputSeq,
  startedAt: ptySession.startedAt,
  closedAt: ptySession.closedAt,
});

const rollbackFailedPtyPatchRelaunch = async (args: {
  taskId: string;
  previousTask: {
    projectId: string;
    title: string;
    taskType?: string | null;
    status: string;
    agentHost: string | null;
    executionHost: string | null;
    backendType: string | null;
    sessionId: string | null;
    sessionFilePath: string | null;
    launchConfig?: string | null;
    metadata: string | null;
  };
  previousPtySession?: {
    taskId: string;
    state: string;
    entrypointType: string | null;
    toolPreset: string | null;
    commandJson: string | null;
    cwd: string | null;
    envJson: string | null;
    shell: string | null;
    pid: number | null;
    cols: number | null;
    rows: number | null;
    lastOutputSeq: number;
    startedAt: Date | null;
    closedAt: Date | null;
  } | null;
}) => {
  await db.$transaction(async (tx) => {
    await tx.task.update({
      where: { id: args.taskId },
      data: buildTaskRollbackData(args.previousTask),
    });

    if (args.previousPtySession) {
      const rollbackPtySession = buildPtySessionRollbackWrite(args.previousPtySession);
      await tx.ptySession.upsert({
        where: { taskId: args.taskId },
        update: rollbackPtySession,
        create: rollbackPtySession,
      });
      return;
    }

    await tx.ptySession.deleteMany({
      where: { taskId: args.taskId },
    });
  });
};

const stopTaskBeforeRelaunch = async (args: {
  userId: string;
  taskId: string;
  projectId: string;
  stopTargetHost: string;
  reason: string;
}): Promise<{ ok: boolean; error?: string }> => {
  const requestId = randomUUID();
  const ackPromise = realtimeHub.waitForTaskStopAck(
    args.taskId,
    requestId,
    STOP_TASK_ACK_TIMEOUT_MS,
  );
  const finalStatusPromise = realtimeHub.waitForTaskFinalStatus(
    args.taskId,
    STOP_TASK_FINAL_STATUS_TIMEOUT_MS,
  );
  realtimeHub.bindTaskToAgent(args.taskId, args.stopTargetHost);
  const { delivered } = await enqueueAndAttemptAgentCommand(
    {
      userId: args.userId,
      agentHost: args.stopTargetHost,
      taskId: args.taskId,
      eventType: "stop_task",
      requestId,
      envelope: {
        type: "stop_task",
        payload: {
          task_id: args.taskId,
          project_id: args.projectId,
          request_id: requestId,
          reason: args.reason,
        },
      },
    },
    {
      agentHost: args.stopTargetHost,
      sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
      resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
    },
  );

  const hostActive = realtimeHub.hasAgentHost(args.stopTargetHost, args.userId);
  if (!delivered) {
    return hostActive
      ? { ok: false, error: `Failed to stop running PTY task on ${args.stopTargetHost}` }
      : { ok: true };
  }

  await ackPromise;
  const finalStatus = await finalStatusPromise;
  if (finalStatus === "completed" || finalStatus === "killed") {
    return { ok: true };
  }

  return hostActive
    ? { ok: false, error: `Timed out waiting for PTY task ${args.taskId} to stop on ${args.stopTargetHost}` }
    : { ok: true };
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const task = await findTaskDetail(user.id, taskId);

  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    ...serializeTaskResponse(task),
    messages: task.messages.map((m) => buildMessageResponse(m)),
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, any>)
      : {};

  const existing = await findTaskForPatch(user.id, taskId);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const projectIdInput = readPatchField(normalizedBody, "project_id", "projectId");
  const nextProjectId =
    typeof projectIdInput === "string" && projectIdInput.trim()
      ? projectIdInput.trim()
      : existing.projectId;
  const taskTypeInput = readPatchField(normalizedBody, "task_type", "taskType");
  if (taskTypeInput !== undefined && parseTaskType(taskTypeInput) === null) {
    return NextResponse.json({ error: "invalid task_type" }, { status: 400 });
  }
  const nextTaskType =
    taskTypeInput !== undefined
      ? normalizeTaskType(taskTypeInput)
      : normalizeTaskType(existing.taskType);
  const hasLaunchConfigField =
    Object.prototype.hasOwnProperty.call(normalizedBody, "launch_config") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "launchConfig");
  const rawLaunchConfig = readPatchField(normalizedBody, "launch_config", "launchConfig");
  if (hasLaunchConfigField && rawLaunchConfig != null && parseJsonObject(rawLaunchConfig) === null) {
    return NextResponse.json({ error: "launch_config must be an object" }, { status: 400 });
  }
  const nextLaunchConfig = hasLaunchConfigField
    ? parseJsonObject(rawLaunchConfig)
    : parseJsonObject(existing.launchConfig);

  // Validate project_id if provided
  if (nextProjectId !== existing.projectId) {
    const newProject = await db.project.findFirst({
      where: { id: nextProjectId, userId: user.id },
    });
    if (!newProject) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
  }

  const hasStatusField = Object.prototype.hasOwnProperty.call(normalizedBody, "status");
  const agentHostInput = readPatchField(normalizedBody, "agent_host", "agentHost");
  const sessionIdInput = readPatchField(normalizedBody, "session_id", "sessionId");
  const sessionFilePathInput = readPatchField(
    normalizedBody,
    "session_file_path",
    "sessionFilePath"
  );
  const backendTypeInput = readPatchField(normalizedBody, "backend_type", "backendType");
  const hasMetadataField = Object.prototype.hasOwnProperty.call(normalizedBody, "metadata");
  const nextBackendType =
    backendTypeInput !== undefined
      ? normalizeBackendType(backendTypeInput)
      : existing.backendType;
  const nextAgentHostInput =
    agentHostInput !== undefined
      ? normalizeOptionalString(agentHostInput)
      : existing.agentHost;
  const existingTaskType = normalizeTaskType(existing.taskType);
  const shouldDispatchPtyTask =
    nextTaskType === "pty_task" &&
    (existingTaskType !== "pty_task" ||
      hasLaunchConfigField ||
      agentHostInput !== undefined);

  if (nextTaskType === "pty_task") {
    const launchConfigError = validatePtyLaunchConfig(nextLaunchConfig);
    if (launchConfigError) {
      return NextResponse.json({ error: launchConfigError }, { status: 400 });
    }
  }

  let nextAgentHost = nextAgentHostInput;
  if (nextTaskType === "pty_task" && shouldDispatchPtyTask) {
    const resolvedPtyAgent = resolvePtyAgentHost({
      connectedAgents: realtimeHub.getAgentsForUser(user.id) as ConnectedAgent[],
      requestedAgentHost: nextAgentHost,
      requestedBackendType: nextBackendType,
      launchConfig: nextLaunchConfig,
    });
    if ("error" in resolvedPtyAgent) {
      return NextResponse.json({ error: resolvedPtyAgent.error }, { status: resolvedPtyAgent.status });
    }
    nextAgentHost = resolvedPtyAgent.agentHost;
  }

  const stopTargetHost = shouldDispatchPtyTask
    ? normalizeHost(realtimeHub.getTaskAgentHost(taskId)) ||
      normalizeHost(existing.executionHost) ||
      normalizeHost(existing.agentHost)
    : "";
  const shouldStopBeforeRelaunch =
    Boolean(stopTargetHost) &&
    shouldDispatchPtyTask &&
    (() => {
      const normalizedExistingStatus = normalizeTaskStatus(existing.status);
      return normalizedExistingStatus === "running" || normalizedExistingStatus === "unknown";
    })();

  const nextStatus = shouldDispatchPtyTask
    ? "unknown"
    : hasStatusField
      ? normalizeTaskStatus(normalizedBody.status)
      : existing.status;
  const executionHostInput = readPatchField(normalizedBody, "execution_host", "executionHost");
  const nextExecutionHost =
    shouldDispatchPtyTask || nextStatus === "completed" || nextStatus === "killed"
      ? null
      : executionHostInput !== undefined
        ? normalizeOptionalString(executionHostInput)
        : existing.executionHost;

  const nextMetadata = hasMetadataField
    ? normalizedBody.metadata
      ? JSON.stringify(normalizedBody.metadata)
      : null
    : existing.metadata;
  const taskUpdateData = {
    projectId: nextProjectId,
    title: normalizedBody.title ?? existing.title,
    taskType: nextTaskType,
    status: nextStatus,
    agentHost: nextAgentHost,
    executionHost: nextExecutionHost,
    backendType: nextBackendType,
    sessionId:
      sessionIdInput !== undefined
        ? normalizeOptionalString(sessionIdInput)
        : existing.sessionId,
    sessionFilePath:
      sessionFilePathInput !== undefined
        ? normalizeOptionalString(sessionFilePathInput)
        : existing.sessionFilePath,
    launchConfig: hasLaunchConfigField
      ? (nextLaunchConfig ? JSON.stringify(nextLaunchConfig) : null)
      : existing.launchConfig,
    metadata: nextMetadata,
  };

  let task;
  let ptySession = null;
  if (nextTaskType === "pty_task") {
    try {
      const result = await db.$transaction(async (tx) => {
        const updatedTask = await tx.task.update({
          where: { id: taskId },
          data: taskUpdateData,
        });
        const updatedPtySession = await tx.ptySession.upsert({
          where: { taskId },
          update: shouldDispatchPtyTask
            ? buildPtySessionRestartPatch(nextLaunchConfig)
            : buildPtySessionConfigPatch(nextLaunchConfig),
          create: buildPtySessionCreateSeed(taskId, nextLaunchConfig),
        });
        return {
          task: updatedTask,
          ptySession: updatedPtySession,
        };
      });
      task = result.task;
      ptySession = result.ptySession;
    } catch (error) {
      if (isMissingPtySchemaError(error)) {
        return NextResponse.json({ error: PTY_SCHEMA_UNAVAILABLE_MESSAGE }, { status: 409 });
      }
      throw error;
    }

    if (shouldStopBeforeRelaunch && stopTargetHost) {
      const stopResult = await stopTaskBeforeRelaunch({
        userId: user.id,
        taskId,
        projectId: existing.projectId,
        stopTargetHost,
        reason: "restart_pty_task",
      });
      if (!stopResult.ok) {
        await rollbackFailedPtyPatchRelaunch({
          taskId,
          previousTask: existing,
          previousPtySession: existing.ptySession,
        });
        return NextResponse.json({ error: stopResult.error }, { status: 409 });
      }
    }

    if (shouldDispatchPtyTask && nextAgentHost && ptySession) {
      await dispatchPtyTaskCreation({
        userId: user.id,
        agentHost: nextAgentHost,
        task: {
          id: taskId,
          projectId: task.projectId,
          title: task.title,
        },
        ptySessionId: ptySession.id,
        launchConfig: nextLaunchConfig,
        bindTaskToAgent: (boundTaskId, boundAgentHost) =>
          realtimeHub.bindTaskToAgent(boundTaskId, boundAgentHost),
        sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
          realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
        resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
      });
    }
  } else if (existingTaskType === "pty_task") {
    task = await db.task.update({
      where: { id: taskId },
      data: taskUpdateData,
    });
    await db.ptySession.deleteMany({
      where: { taskId },
    });
  } else {
    try {
      task = await db.task.update({
        where: { id: taskId },
        data: taskUpdateData,
      });
    } catch (error) {
      if (!isMissingPtySchemaError(error)) {
        throw error;
      }
      task = applyLegacyTaskShape(
        await db.task.update({
          where: { id: taskId },
          data: {
            projectId: nextProjectId,
            title: normalizedBody.title ?? existing.title,
            status: nextStatus,
            agentHost: nextAgentHost,
            executionHost: nextExecutionHost,
            backendType: nextBackendType,
            sessionId:
              sessionIdInput !== undefined
                ? normalizeOptionalString(sessionIdInput)
                : existing.sessionId,
            sessionFilePath:
              sessionFilePathInput !== undefined
                ? normalizeOptionalString(sessionFilePathInput)
                : existing.sessionFilePath,
            metadata: nextMetadata,
          },
          select: legacyTaskSelect,
        }),
      );
    }
  }

  return NextResponse.json(serializeTaskResponse({ ...task, ptySession }));
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ taskId: string }> }
) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { taskId } = await params;
  const existing = await db.task.findFirst({
    where: { id: taskId, project: { userId: user.id } },
    select: { id: true, projectId: true, agentHost: true, executionHost: true, status: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const payload = await buildTaskDiagnosticsPayload({
      userId: user.id,
      taskId,
      includeRemoteFireLogs: false,
    });
    if (payload) {
      await db.taskDiagnosticsSnapshot.create({
        data: {
          userId: user.id,
          projectId: existing.projectId,
          taskId,
          trigger: DELETE_SNAPSHOT_TRIGGER,
          payloadJson: JSON.stringify(payload),
        },
      });
    }
  } catch (error) {
    console.error(
      `[tasks] failed to persist diagnostics snapshot before delete: taskId=${taskId}, userId=${user.id}, error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const normalizedStatus = normalizeTaskStatus(existing.status);
  const needsStop = normalizedStatus === "running" || normalizedStatus === "unknown";
  const boundHost = normalizeHost(realtimeHub.getTaskAgentHost(taskId));
  const stopTargetHost =
    boundHost ||
    normalizeHost(existing.executionHost) ||
    normalizeHost(existing.agentHost);

  if (needsStop) {
    if (stopTargetHost) {
      const requestId = randomUUID();
      const ackPromise = realtimeHub.waitForTaskStopAck(taskId, requestId, 2500);
      realtimeHub.bindTaskToAgent(taskId, stopTargetHost);
      const { delivered } = await enqueueAndAttemptAgentCommand(
        {
          userId: user.id,
          agentHost: stopTargetHost,
          taskId,
          eventType: "stop_task",
          requestId,
          envelope: {
            type: "stop_task",
            payload: {
              task_id: taskId,
              project_id: existing.projectId,
              request_id: requestId,
              reason: "deleted_by_user",
            },
          },
        },
        {
          agentHost: stopTargetHost,
          sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
            realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
          resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
        },
      );

      if (delivered) {
        // Best effort stop: don't block deletion on daemon ack/status,
        // to keep delete responsive across daemon versions and stale bindings.
        await ackPromise;
      }
    }
  }

  // Keep delete behavior robust across DB engines/migrations by removing children first.
  await db.message.deleteMany({
    where: { taskId },
  });
  try {
    await db.ptySession.deleteMany({
      where: { taskId },
    });
  } catch (error) {
    if (!isMissingPtySchemaError(error)) {
      throw error;
    }
  }
  await db.task.delete({ where: { id: taskId } });
  try {
    await deleteTaskAttachmentDirectory(taskId);
  } catch (error) {
    console.error(
      `[tasks] failed to delete attachment directory after task delete: taskId=${taskId}, error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  realtimeHub.broadcast(user.id, existing.projectId, {
    type: "task_deleted",
    payload: {
      task_id: taskId,
      project_id: existing.projectId,
    },
  });
  realtimeHub.unbindTask(taskId);

  return new NextResponse(null, { status: 204 });
}

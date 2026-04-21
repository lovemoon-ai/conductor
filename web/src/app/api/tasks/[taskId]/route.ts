import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { buildTaskDiagnosticsPayload } from "@/lib/diagnostics/task-diagnostics";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  deliverAgentOutboxRow,
  enqueueAndAttemptAgentCommand,
  isMissingAgentOutboxTableError,
  warnMissingAgentOutboxTable,
} from "@/lib/realtime/agent-outbox";
import { serializeTaskResponse } from "@/lib/tasks/serialization";
import { deleteTaskAttachmentDirectory } from "@/lib/tasks/task-file-storage";
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  normalizeTaskType,
  parseJsonObject,
  parseTaskType,
  type JsonObject,
} from "@/lib/tasks/task-config";
import {
  applyLegacyTaskShape,
  isMissingAnyNewSchemaError,
  isMissingIssueIdSchemaError,
  isMissingPtySchemaError,
  legacyTaskSelect,
  PTY_SCHEMA_UNAVAILABLE_MESSAGE,
  taskSelectWithoutIssueId,
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
import { recoverStaleDisconnectedAgentTasks } from "@/lib/tasks/stale-recovery";
import {
  acquireTaskWorktreeMutationLock,
  buildTaskWorktreeCleanupOutboxData,
  hasSameTaskWorktreeRoot,
  resolveTaskWorktreeCleanupHost,
  parseTaskWorktreeLaunchConfig,
} from "@/lib/tasks/worktree";
import {
  resolveTaskStopTargetHost,
  stopTaskBeforeRelaunch,
} from "@/lib/tasks/task-stop";

const DELETE_SNAPSHOT_TRIGGER = "task_delete";
const KILLING_TIMEOUT_MS = 60_000;

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

const findTaskDetail = async (userId: string, taskId: string) =>
  withPtySchemaFallback(
    "tasks.taskId.GET",
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
      return task ? { ...applyLegacyTaskShape(task), issueId: null } : null;
    },
    async () => {
      const task = await db.task.findFirst({
        where: { id: taskId, project: { userId } },
        select: {
          ...taskSelectWithoutIssueId,
          ptySession: true,
        },
      });
      return task ? { ...task, issueId: null } : null;
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
      return task ? { ...applyLegacyTaskShape(task), issueId: null } : null;
    },
    async () => {
      const task = await db.task.findFirst({
        where: { id: taskId, project: { userId } },
        select: {
          ...taskSelectWithoutIssueId,
          ptySession: true,
        },
      });
      return task ? { ...task, issueId: null } : null;
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

const buildLegacyAiTaskWriteData = (task: {
  projectId: string;
  title: string;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  backendType: string | null;
  sessionId: string | null;
  sessionFilePath: string | null;
  metadata: string | null;
}) => ({
  projectId: task.projectId,
  title: task.title,
  status: task.status,
  agentHost: task.agentHost,
  executionHost: task.executionHost,
  backendType: task.backendType,
  sessionId: task.sessionId,
  sessionFilePath: task.sessionFilePath,
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

const rollbackFailedAiTaskPatch = async (args: {
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
}) => {
  try {
    await db.task.update({
      where: { id: args.taskId },
      data: buildTaskRollbackData(args.previousTask),
    });
  } catch (error) {
    if (isMissingIssueIdSchemaError(error)) {
      await db.task.update({
        where: { id: args.taskId },
        data: buildTaskRollbackData(args.previousTask),
        select: taskSelectWithoutIssueId,
      });
      return;
    }
    if (!isMissingPtySchemaError(error)) {
      throw error;
    }
    await db.task.update({
      where: { id: args.taskId },
      data: buildLegacyAiTaskWriteData({
        projectId: args.previousTask.projectId,
        title: args.previousTask.title,
        status: args.previousTask.status,
        agentHost: args.previousTask.agentHost,
        executionHost: args.previousTask.executionHost,
        backendType: args.previousTask.backendType,
        sessionId: args.previousTask.sessionId,
        sessionFilePath: args.previousTask.sessionFilePath,
        metadata: args.previousTask.metadata,
      }),
      select: legacyTaskSelect,
    });
  }
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

  const { searchParams } = new URL(request.url);
  if (searchParams.get("recover_stale") === "1") {
    await recoverStaleDisconnectedAgentTasks(user.id, [task] as any);
  }

  return NextResponse.json(serializeTaskResponse(task));
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
  const metadataInput = hasMetadataField ? normalizedBody.metadata : undefined;
  const parsedMetadataInput = hasMetadataField && metadataInput != null ? parseJsonObject(metadataInput) : null;
  if (hasMetadataField && metadataInput != null && parsedMetadataInput === null) {
    return NextResponse.json({ error: "metadata must be an object" }, { status: 400 });
  }
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
  const normalizedExistingStatus = normalizeTaskStatus(existing.status);

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

  const requestedStatus = hasStatusField
    ? normalizeTaskStatus(normalizedBody.status)
    : normalizeTaskStatus(existing.status);
  const isKillStatusRequest = hasStatusField && requestedStatus === "killed";
  const shouldEnterKilling =
    !shouldDispatchPtyTask &&
    nextTaskType === "ai_task" &&
    isKillStatusRequest &&
    (
      normalizedExistingStatus === "init" ||
      normalizedExistingStatus === "running" ||
      normalizedExistingStatus === "unknown"
    );
  const shouldKeepKilling =
    !shouldDispatchPtyTask &&
    nextTaskType === "ai_task" &&
    isKillStatusRequest &&
    normalizedExistingStatus === "killing";
  const nextStatus = shouldDispatchPtyTask
    ? "unknown"
    : shouldEnterKilling || shouldKeepKilling
      ? "killing"
      : hasStatusField
        ? requestedStatus
        : existing.status;
  const shouldStopTask = shouldEnterKilling;
  const stopTargetHost = shouldDispatchPtyTask || shouldStopTask
    ? resolveTaskStopTargetHost({
        taskId,
        executionHost: existing.executionHost,
        agentHost: existing.agentHost,
      })
    : "";
  if (shouldStopTask && !stopTargetHost) {
    return NextResponse.json({ error: "Task missing active daemon binding" }, { status: 409 });
  }
  const shouldStopBeforeRelaunch =
    Boolean(stopTargetHost) &&
    shouldDispatchPtyTask &&
    (normalizedExistingStatus === "running" ||
      normalizedExistingStatus === "killing" ||
      normalizedExistingStatus === "unknown");
  const executionHostInput = readPatchField(normalizedBody, "execution_host", "executionHost");
  const nextExecutionHost = shouldStopTask
    ? stopTargetHost
    : shouldDispatchPtyTask || nextStatus === "completed" || nextStatus === "killed"
      ? null
      : executionHostInput !== undefined
        ? normalizeOptionalString(executionHostInput)
        : existing.executionHost;
  const existingMetadataObject = parseJsonObject(existing.metadata);
  const stopTaskRequestId = shouldStopTask ? randomUUID() : null;
  const killingStartedAt = shouldStopTask ? new Date().toISOString() : null;
  const stopTaskEnvelope =
    shouldStopTask && stopTaskRequestId
      ? {
          type: "stop_task",
          payload: {
            task_id: taskId,
            project_id: existing.projectId,
            request_id: stopTaskRequestId,
            reason: "stopped_from_app",
          },
        }
      : null;

  const nextMetadata = shouldStopTask
    ? JSON.stringify({
        ...(hasMetadataField ? parsedMetadataInput ?? {} : existingMetadataObject ?? {}),
        killingStartedAt,
        killingTimeoutMs: KILLING_TIMEOUT_MS,
        killRequestId: stopTaskRequestId,
      })
    : hasMetadataField
      ? metadataInput == null
        ? null
        : JSON.stringify({
            ...(existingMetadataObject ?? {}),
            ...(parsedMetadataInput ?? {}),
          })
      : existing.metadata;
  const baseAiTaskUpdateData = {
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
  };
  const legacyAiTaskUpdateData = buildLegacyAiTaskWriteData({
    projectId: baseAiTaskUpdateData.projectId,
    title: baseAiTaskUpdateData.title,
    status: baseAiTaskUpdateData.status,
    agentHost: baseAiTaskUpdateData.agentHost,
    executionHost: baseAiTaskUpdateData.executionHost,
    backendType: baseAiTaskUpdateData.backendType,
    sessionId: baseAiTaskUpdateData.sessionId,
    sessionFilePath: baseAiTaskUpdateData.sessionFilePath,
    metadata: baseAiTaskUpdateData.metadata,
  });
  const taskUpdateData = {
    ...baseAiTaskUpdateData,
    taskType: nextTaskType,
    launchConfig: hasLaunchConfigField
      ? (nextLaunchConfig ? JSON.stringify(nextLaunchConfig) : null)
      : existing.launchConfig,
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
        taskLabel: "PTY task",
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
      if (shouldStopTask && stopTargetHost && stopTaskRequestId && stopTaskEnvelope) {
        realtimeHub.bindTaskToAgent(taskId, stopTargetHost);
        const runStopTaskUpdateTransaction = async (
          mode: "full" | "issueId" | "legacy",
          persistOutbox: boolean,
        ) =>
          db.$transaction(async (tx) => {
            const updatedTaskRaw =
              mode === "full"
                ? await tx.task.update({
                    where: { id: taskId },
                    data: taskUpdateData,
                  })
                : mode === "issueId"
                  ? await tx.task.update({
                      where: { id: taskId },
                      data: taskUpdateData,
                      select: taskSelectWithoutIssueId,
                    })
                  : await tx.task.update({
                      where: { id: taskId },
                      data: legacyAiTaskUpdateData,
                      select: legacyTaskSelect,
                    });
            const updatedTask =
              mode === "legacy"
                ? applyLegacyTaskShape(updatedTaskRaw)
                : mode === "issueId"
                  ? { ...updatedTaskRaw, issueId: null }
                  : updatedTaskRaw;
            if (!persistOutbox) {
              return {
                task: updatedTask,
                stopOutboxRow: null,
                useDirectDeliveryFallback: true,
              };
            }
            const stopOutboxRow = await tx.agentOutbox.create({
              data: {
                userId: user.id,
                agentHost: stopTargetHost,
                taskId,
                eventType: "stop_task",
                requestId: stopTaskRequestId,
                payloadJson: JSON.stringify(stopTaskEnvelope),
                status: "pending",
                attemptCount: 0,
                nextRetryAt: null,
              },
            });
            return {
              task: updatedTask,
              stopOutboxRow,
              useDirectDeliveryFallback: false,
            };
          });
        const runCompatibleStopTaskUpdateTransaction = async () => {
          try {
            return await runStopTaskUpdateTransaction("full", true);
          } catch (error) {
            if (isMissingAgentOutboxTableError(error)) {
              warnMissingAgentOutboxTable(error);
              return runStopTaskUpdateTransaction("full", false);
            }
            if (isMissingIssueIdSchemaError(error)) {
              try {
                return await runStopTaskUpdateTransaction("issueId", true);
              } catch (fallbackError) {
                if (isMissingAgentOutboxTableError(fallbackError)) {
                  warnMissingAgentOutboxTable(fallbackError);
                  return runStopTaskUpdateTransaction("issueId", false);
                }
                if (!isMissingPtySchemaError(fallbackError)) {
                  throw fallbackError;
                }
              }
            }
            if (!isMissingPtySchemaError(error) && !isMissingIssueIdSchemaError(error)) {
              throw error;
            }
            try {
              return await runStopTaskUpdateTransaction("legacy", true);
            } catch (legacyError) {
              if (isMissingAgentOutboxTableError(legacyError)) {
                warnMissingAgentOutboxTable(legacyError);
                return runStopTaskUpdateTransaction("legacy", false);
              }
              throw legacyError;
            }
          }
        };
        const stopResult = await runCompatibleStopTaskUpdateTransaction();
        task = stopResult.task;
        try {
          if (stopResult.stopOutboxRow) {
            await deliverAgentOutboxRow(stopResult.stopOutboxRow, {
              userId: user.id,
              agentHost: stopTargetHost,
              sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
                realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
              resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
            });
          } else if (stopResult.useDirectDeliveryFallback) {
            const directStopResult = await enqueueAndAttemptAgentCommand(
              {
                userId: user.id,
                agentHost: stopTargetHost,
                taskId,
                eventType: "stop_task",
                requestId: stopTaskRequestId,
                envelope: stopTaskEnvelope,
              },
              {
                agentHost: stopTargetHost,
                sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
                  realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
                resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
              },
            );
            if (!directStopResult.delivered) {
              await rollbackFailedAiTaskPatch({
                taskId,
                previousTask: existing,
              });
              return NextResponse.json(
                {
                  error: `Failed to request task kill: task daemon ${stopTargetHost} is offline`,
                },
                { status: 409 },
              );
            }
          }
        } catch (error) {
          if (stopResult.useDirectDeliveryFallback) {
            await rollbackFailedAiTaskPatch({
              taskId,
              previousTask: existing,
            });
            return NextResponse.json(
              {
                error: `Failed to request task kill: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              },
              { status: 409 },
            );
          }
          console.error(
            `[tasks] failed to deliver queued stop_task for task ${taskId} to ${stopTargetHost}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      } else {
        task = await db.task.update({
          where: { id: taskId },
          data: taskUpdateData,
        });
      }
    } catch (error) {
      if (shouldStopTask) {
        return NextResponse.json(
          {
            error: `Failed to request task kill: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
          { status: 409 },
        );
      }
      if (isMissingIssueIdSchemaError(error)) {
        // taskUpdateData has no issueId field, so we can pass it directly
        const updated = await db.task.update({
          where: { id: taskId },
          data: taskUpdateData,
          select: taskSelectWithoutIssueId,
        });
        task = { ...updated, issueId: null };
      } else if (isMissingPtySchemaError(error)) {
        task = applyLegacyTaskShape(
          await db.task.update({
            where: { id: taskId },
            data: legacyAiTaskUpdateData,
            select: legacyTaskSelect,
          }),
        );
      } else {
        throw error;
      }
    }
  }
  if (shouldEnterKilling) {
    realtimeHub.broadcast(user.id, task.projectId, {
      type: "task_status_update",
      payload: {
        task_id: task.id,
        project_id: task.projectId,
        status: "killing",
        metadata: parseJsonObject(task.metadata),
        updated_at: task.updatedAt.toISOString(),
      },
    });
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
    select: {
      id: true,
      projectId: true,
      taskType: true,
      agentHost: true,
      executionHost: true,
      status: true,
      launchConfig: true,
      metadata: true,
      project: {
        select: {
          daemonHost: true,
        },
      },
    },
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
  const needsStop =
    normalizedStatus === "running" ||
    normalizedStatus === "killing" ||
    normalizedStatus === "unknown";
  const boundHost = normalizeHost(realtimeHub.getTaskAgentHost(taskId));
  const worktreeConfig =
    (existing.taskType ?? "ai_task") === "ai_task"
      ? parseTaskWorktreeLaunchConfig(existing.launchConfig)
      : null;
  const worktreeCleanupHost = resolveTaskWorktreeCleanupHost({
    boundHost,
    agentHost: existing.agentHost,
    executionHost: existing.executionHost,
    metadata: existing.metadata,
    projectDaemonHost: existing.project?.daemonHost,
  });
  const stopTargetHost =
    worktreeConfig && worktreeCleanupHost
      ? worktreeCleanupHost
      : boundHost ||
        worktreeCleanupHost ||
        normalizeHost(existing.executionHost) ||
        normalizeHost(existing.agentHost) ||
        normalizeHost(existing.project?.daemonHost);

  if (worktreeConfig && !stopTargetHost) {
    return NextResponse.json({ error: "Task missing daemon binding" }, { status: 409 });
  }

  if (needsStop && stopTargetHost) {
    // Best-effort stop on DELETE: try to notify the daemon but do NOT block
    // on convergence. Waiting 30s for a manual-fire worktree task to reach
    // a terminal state would make delete unusable — the fire process is
    // often already gone and the daemon cannot ack the stop. The async
    // worktree cleanup outbox (queued below) reliably removes the worktree
    // directory whenever the daemon reconnects.
    const requestId = randomUUID();
    const ackPromise = realtimeHub.waitForTaskStopAck(taskId, requestId, 2500);
    realtimeHub.bindTaskToAgent(taskId, stopTargetHost);
    let delivered = false;
    try {
      ({ delivered } = await enqueueAndAttemptAgentCommand(
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
      ));
    } catch {
      delivered = false;
    }

    if (delivered) {
      await ackPromise;
    } else {
      realtimeHub.cancelTaskStopAck(taskId, requestId);
    }
  }

  if (worktreeConfig) {
    await db.$transaction(async (tx) => {
      await acquireTaskWorktreeMutationLock(
        tx as any,
        taskId,
      );
      const sharedWorktreeTask =
        (
          await tx.task.findMany({
            where: {
              projectId: existing.projectId,
              id: { not: taskId },
            },
            select: {
              id: true,
              launchConfig: true,
            },
          })
        ).find((candidate) =>
          hasSameTaskWorktreeRoot(existing.launchConfig, candidate.launchConfig),
        ) ?? null;
      if (!sharedWorktreeTask?.id || sharedWorktreeTask.id === taskId) {
        await tx.agentOutbox.create({
          data: buildTaskWorktreeCleanupOutboxData({
            userId: user.id,
            agentHost: stopTargetHost,
            taskId,
            projectId: existing.projectId,
            launchConfig: existing.launchConfig,
            requestId: randomUUID(),
            force: true,
          }),
        });
      }

      await tx.message.deleteMany({
        where: { taskId },
      });
      try {
        await tx.ptySession.deleteMany({
          where: { taskId },
        });
      } catch (error) {
        if (!isMissingPtySchemaError(error)) {
          throw error;
        }
      }
      await tx.task.delete({ where: { id: taskId } });
    });

    try {
      await deleteTaskAttachmentDirectory(taskId);
    } catch (error) {
      console.error(
        `[tasks] failed to delete attachment directory after task delete: taskId=${taskId}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    realtimeHub.unbindTask(taskId);
    return new NextResponse(null, { status: 204 });
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

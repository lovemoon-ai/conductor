import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { deliverAgentOutboxForHost } from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  normalizeOptionalString,
  parseJsonObject,
  serializeJsonObject,
  normalizeTaskStatus,
} from "@/lib/tasks/task-config";
import {
  acquireTaskWorktreeMutationLock,
  inheritTaskWorktreeLaunchConfig,
} from "@/lib/tasks/worktree";
import { normalizeBackendType } from "@/lib/tasks/pty-runtime";
import {
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import {
  canCreateSuccessorTask,
  canInplaceRestart,
  normalizeRestartStrategy,
  RESTARTABLE_SOURCE_STATUSES,
  STOPPED_TASK_STATUSES,
} from "@/lib/tasks/restart";

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
  const project = await db.project.findFirst({
    where: { id: sourceTask.projectId, userId: user.id },
  });
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const isDefaultProject = defaultProject?.projectId === project.id;
  const projectDaemonHost = normalizeOptionalString((project as { daemonHost?: string | null }).daemonHost);
  const projectWorkspacePath = normalizeOptionalString((project as { workspacePath?: string | null }).workspacePath);
  const projectWorktreeBranch = normalizeOptionalString((project as { worktreeBranch?: string | null }).worktreeBranch);
  if (
    (!isDefaultProject && (!projectDaemonHost || !projectWorkspacePath)) ||
    (projectDaemonHost && !projectWorkspacePath) ||
    (!projectDaemonHost && projectWorkspacePath)
  ) {
    return NextResponse.json({ error: "Project binding incomplete" }, { status: 409 });
  }
  if ((sourceTask.taskType ?? "ai_task") !== "ai_task") {
    return NextResponse.json({ error: "Only ai_task supports restart" }, { status: 409 });
  }

  const sourceBackend = normalizeBackendType(sourceTask.backendType);
  if (!sourceBackend) {
    return NextResponse.json({ error: "Task missing backend binding" }, { status: 409 });
  }
  const sourceLaunchConfig = parseJsonObject(sourceTask.launchConfig);
  const inheritedWorktreeLaunchConfig = inheritTaskWorktreeLaunchConfig(sourceLaunchConfig);

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

  const connectedAgents = realtimeHub.getAgentsForUser(user.id);
  const isManualFireTask = isConductorFireHost(sourceAgentHost);
  const sourceTaskMetadata = parseJsonObject(sourceTask.metadata);
  const sourceMetadataDaemonHost = normalizeOptionalString(sourceTaskMetadata?.daemonName);
  const sourceExecutionHost = normalizeOptionalString(sourceTask.executionHost);
  const manualFireDaemonHostCandidates: string[] = [];
  for (const candidate of [
    sourceMetadataDaemonHost && !isConductorFireHost(sourceMetadataDaemonHost)
      ? sourceMetadataDaemonHost
      : null,
    sourceExecutionHost && !isConductorFireHost(sourceExecutionHost)
      ? sourceExecutionHost
      : null,
  ]) {
    if (candidate && !manualFireDaemonHostCandidates.includes(candidate)) {
      manualFireDaemonHostCandidates.push(candidate);
    }
  }
  const sourceExecutionDaemonHost = manualFireDaemonHostCandidates[0] ?? null;

  const hasExplicitBackendTarget =
    Object.prototype.hasOwnProperty.call(normalizedBody, "backend_type") ||
    Object.prototype.hasOwnProperty.call(normalizedBody, "backendType");
  const requestedBackend =
    normalizeBackendType(normalizedBody.backend_type ?? normalizedBody.backendType);
  if (hasExplicitBackendTarget && !requestedBackend) {
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

  // Fire tasks can create new tasks from running state; in-place restart requires stopped state
  const canDoInplaceRestart = STOPPED_TASK_STATUSES.has(sourceStatus as any);
  const isExplicitInplaceRequest = requestedStrategy === "inplace" ||
    (!requestedStrategy && canDoInplaceRestart && targetBackend === sourceBackend);
  if (isManualFireTask && isExplicitInplaceRequest && !canDoInplaceRestart) {
    return NextResponse.json(
      { error: "manual fire task can only in-place restart after it has stopped" },
      { status: 409 },
    );
  }

  let restartAgentHost = isManualFireTask
    ? manualFireDaemonHostCandidates.find((host) =>
        connectedAgents.some((agent) => agent.host === host),
      ) ?? sourceExecutionDaemonHost
    : sourceAgentHost;
  if (projectDaemonHost) {
    if (
      sourceAgentHost &&
      !isConductorFireHost(sourceAgentHost) &&
      sourceAgentHost !== projectDaemonHost
    ) {
      return NextResponse.json(
        { error: `Task daemon ${sourceAgentHost} does not match project binding ${projectDaemonHost}` },
        { status: 409 },
      );
    }
    restartAgentHost = projectDaemonHost;
  }
  if (!restartAgentHost) {
    return NextResponse.json(
      {
        error: isManualFireTask
          ? "Task missing original daemon binding"
          : `No compatible daemon online for backend ${targetBackend}`,
      },
      { status: 409 },
    );
  }
  const restartAgent = connectedAgents.find((agent) => agent.host === restartAgentHost) ?? null;
  if (!restartAgent) {
    return NextResponse.json(
      {
        error: projectDaemonHost
          ? `Project daemon ${restartAgentHost} is offline`
          : isManualFireTask
            ? `Original daemon ${restartAgentHost} is offline`
            : `Source daemon ${sourceAgentHost} is offline`,
      },
      { status: 409 },
    );
  }
  const supportedBackends = Array.isArray(restartAgent.supportedBackends) ? restartAgent.supportedBackends : [];
  const runtimeBackendMap =
    restartAgent.runtimeBackendMap && typeof restartAgent.runtimeBackendMap === "object"
      ? restartAgent.runtimeBackendMap
      : undefined;
  if (!supportedBackends.includes(targetBackend)) {
    return NextResponse.json(
      { error: `Daemon ${restartAgentHost} does not support backend ${targetBackend}` },
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

  if (!isInplaceRestart && !canCreateSuccessorTask(sourceBackend, targetBackend, {
    sourceRuntimeBackendMap: runtimeBackendMap,
    targetRuntimeBackendMap: runtimeBackendMap,
  })) {
    return NextResponse.json(
      { error: `Backend switch ${sourceBackend} -> ${targetBackend} is not supported` },
      { status: 409 },
    );
  }


  const requestId = randomUUID();
  const now = new Date();

  if (isInplaceRestart) {
    const updatedTask = await db.$transaction(async (tx) => {
      if (inheritedWorktreeLaunchConfig) {
        await acquireTaskWorktreeMutationLock(
          tx as any,
          sourceTask.id,
        );
      }

      await tx.agentOutbox.create({
        data: {
          userId: user.id,
          agentHost: restartAgentHost,
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
              target_launch_config: inheritedWorktreeLaunchConfig ?? undefined,
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
          status: "running",
          executionHost: restartAgentHost,
          agentHost: restartAgentHost,
          updatedAt: now,
        },
      });
    });

    realtimeHub.bindTaskToAgent(sourceTask.id, restartAgentHost);
    await deliverAgentOutboxForHost({
      userId: user.id,
      agentHost: restartAgentHost,
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
  const successorLaunchConfig = inheritedWorktreeLaunchConfig ?? {
    ...(projectWorkspacePath ? { cwd: projectWorkspacePath } : {}),
    ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
  };

  const createdTask = await db.$transaction(async (tx) => {
    if (inheritedWorktreeLaunchConfig) {
      await acquireTaskWorktreeMutationLock(
        tx as any,
        sourceTask.id,
        sourceTask.launchConfig as string | null,
      );
    }

    const task = await tx.task.create({
      data: {
        id: successorTaskId,
        projectId: sourceTask.projectId,
        title: successorTitle,
        taskType: "ai_task",
        status: "init",
        agentHost: restartAgentHost,
        executionHost: null,
        backendType: targetBackend,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: serializeJsonObject(
          Object.keys(successorLaunchConfig).length > 0 ? successorLaunchConfig : null,
        ),
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
        agentHost: restartAgentHost,
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
            target_launch_config:
              Object.keys(successorLaunchConfig).length > 0
                ? successorLaunchConfig
                : undefined,
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

  realtimeHub.bindTaskToAgent(successorTaskId, restartAgentHost);
  await deliverAgentOutboxForHost({
    userId: user.id,
    agentHost: restartAgentHost,
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

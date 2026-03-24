import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import {
  normalizeOptionalString,
  normalizeTaskType,
  parseJsonObject,
  parseTaskType,
  serializeJsonObject,
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
  buildPtySessionCreateSeed,
  dispatchPtyTaskCreation,
  normalizeBackendType,
  pickDefaultAgentHost,
  resolvePtyAgentHost,
  validatePtyLaunchConfig,
  type ConnectedAgent,
} from "@/lib/tasks/pty-runtime";
import {
  countActiveTaskBuckets,
  exceedsTaskLimit,
  getTaskLimitMessage,
  getTaskPlanBucket,
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import { recoverStaleDisconnectedAgentTasks } from "@/lib/tasks/stale-recovery";

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const readBodyField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string
): unknown => {
  if (hasOwn(body, snakeCaseKey)) {
    return body[snakeCaseKey];
  }
  if (hasOwn(body, camelCaseKey)) {
    return body[camelCaseKey];
  }
  return undefined;
};

const hasBodyField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string
): boolean => hasOwn(body, snakeCaseKey) || hasOwn(body, camelCaseKey);

const parseJsonField = (
  body: Record<string, unknown>,
  snakeCaseKey: string,
  camelCaseKey: string
): { hasField: boolean; value: JsonObject | null; raw: unknown } => {
  const hasField = hasBodyField(body, snakeCaseKey, camelCaseKey);
  const raw = hasField ? readBodyField(body, snakeCaseKey, camelCaseKey) : undefined;
  return {
    hasField,
    raw,
    value: parseJsonObject(raw),
  };
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
  lastUserMessage?: string | null;
  lastAssistantMessage?: string | null;
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
  last_user_message: task.lastUserMessage ?? null,
  last_assistant_message: task.lastAssistantMessage ?? null,
  created_at: task.createdAt.toISOString(),
  updated_at: task.updatedAt.toISOString(),
  ...(task.ptySession !== undefined ? { pty_session: serializePtySession(task.ptySession) } : {}),
});

const buildTaskMessagePreviews = async (
  taskIds: string[],
): Promise<Record<string, { lastUserMessage: string | null; lastAssistantMessage: string | null }>> => {
  if (taskIds.length === 0) {
    return {};
  }

  const messages = await db.message.findMany({
    where: {
      taskId: { in: taskIds },
      role: { in: ["user", "assistant"] },
    },
    select: {
      taskId: true,
      role: true,
      content: true,
      createdAt: true,
    },
    orderBy: [
      { createdAt: "desc" },
      { id: "desc" as const },
    ],
  });

  const previews: Record<string, { lastUserMessage: string | null; lastAssistantMessage: string | null }> = {};

  for (const taskId of taskIds) {
    previews[taskId] = {
      lastUserMessage: null,
      lastAssistantMessage: null,
    };
  }

  for (const message of messages) {
    const target = previews[message.taskId];
    if (!target) {
      continue;
    }

    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) {
      continue;
    }

    if (message.role === "user" && target.lastUserMessage == null) {
      target.lastUserMessage = content;
    }

    if (message.role === "assistant" && target.lastAssistantMessage == null) {
      target.lastAssistantMessage = content;
    }

    if (target.lastUserMessage && target.lastAssistantMessage) {
      continue;
    }
  }

  return previews;
};

const findTasksForList = async (userId: string, projectId: string | null) =>
  withPtySchemaFallback(
    "tasks.GET.list",
    () =>
      db.task.findMany({
        where: {
          project: { userId },
          ...(projectId ? { projectId } : {}),
        },
        include: {
          ptySession: true,
        },
      }),
    async () =>
      (await db.task.findMany({
        where: {
          project: { userId },
          ...(projectId ? { projectId } : {}),
        },
        select: legacyTaskSelect,
      })).map((task) => applyLegacyTaskShape(task)),
  );

const getTaskListSortTime = (task: { updatedAt?: Date | null; createdAt: Date }) =>
  (task.updatedAt instanceof Date ? task.updatedAt : task.createdAt).getTime();

const createTaskRecord = async (args: {
  requestedId?: string;
  projectId: string;
  title: string;
  taskType: string;
  status: string;
  agentHost: string | null;
  requestedBackendType: string | null;
  requestedSessionId: string | null;
  requestedSessionFilePath: string | null;
  launchConfig: JsonObject | null;
  metadata: JsonObject | null;
}) => {
  try {
    return await db.task.create({
      data: {
        id: args.requestedId,
        projectId: args.projectId,
        title: args.title,
        taskType: args.taskType,
        status: args.status,
        agentHost: args.agentHost,
        executionHost: args.taskType === "ai_task" ? args.agentHost ?? null : null,
        backendType: args.requestedBackendType,
        sessionId: args.requestedSessionId,
        sessionFilePath: args.requestedSessionFilePath,
        launchConfig: serializeJsonObject(args.launchConfig),
        metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      },
    });
  } catch (error) {
    if (!isMissingPtySchemaError(error)) {
      throw error;
    }
    if (args.taskType === "pty_task") {
      throw error;
    }
    return applyLegacyTaskShape(
      await db.task.create({
        data: {
          id: args.requestedId,
          projectId: args.projectId,
          title: args.title,
          status: args.status,
          agentHost: args.agentHost,
          executionHost: args.agentHost ?? null,
          backendType: args.requestedBackendType,
          sessionId: args.requestedSessionId,
          sessionFilePath: args.requestedSessionFilePath,
          metadata: args.metadata ? JSON.stringify(args.metadata) : null,
        },
        select: legacyTaskSelect,
      }),
    );
  }
};

const createPtyTaskRecord = async (args: {
  requestedId?: string;
  projectId: string;
  title: string;
  status: string;
  agentHost: string | null;
  requestedBackendType: string | null;
  requestedSessionId: string | null;
  requestedSessionFilePath: string | null;
  launchConfig: JsonObject | null;
  metadata: JsonObject | null;
}) =>
  db.$transaction(async (tx) => {
    const task = await tx.task.create({
      data: {
        id: args.requestedId,
        projectId: args.projectId,
        title: args.title,
        taskType: "pty_task",
        status: args.status,
        agentHost: args.agentHost,
        executionHost: null,
        backendType: args.requestedBackendType,
        sessionId: args.requestedSessionId,
        sessionFilePath: args.requestedSessionFilePath,
        launchConfig: serializeJsonObject(args.launchConfig),
        metadata: args.metadata ? JSON.stringify(args.metadata) : null,
      },
    });

    const ptySession = await tx.ptySession.create({
      data: buildPtySessionCreateSeed(task.id, args.launchConfig),
    });

    return { task, ptySession };
  });

export async function GET(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("project_id");
  const recoverStale = searchParams.get("recover_stale") === "1";

  const tasks = await findTasksForList(user.id, projectId);

  if (recoverStale) {
    await recoverStaleDisconnectedAgentTasks(user.id, tasks as any);
  }

  const taskIds = tasks.map((task) => task.id);
  const messagePreviews = await buildTaskMessagePreviews(taskIds);

  const response = tasks
    .slice()
    .sort((a, b) => {
      const updatedDelta = getTaskListSortTime(b) - getTaskListSortTime(a);
      if (updatedDelta !== 0) {
        return updatedDelta;
      }
      return b.createdAt.getTime() - a.createdAt.getTime();
    })
    .map((task) =>
      serializeTaskResponse({
        ...task,
        lastUserMessage: messagePreviews[task.id]?.lastUserMessage ?? null,
        lastAssistantMessage: messagePreviews[task.id]?.lastAssistantMessage ?? null,
      }),
    );

  return NextResponse.json(response);
}

export async function POST(request: NextRequest) {
  const userResult = await getActiveSubscriptionUser(request);
  if (userResult instanceof Response) return userResult;
  const user = userResult;

  const body = await request.json();
  const normalizedBody =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const projectId = normalizeOptionalString(
    readBodyField(normalizedBody, "project_id", "projectId")
  );
  if (!projectId) {
    return NextResponse.json({ error: "project_id required" }, { status: 400 });
  }

  const project = await db.project.findFirst({
    where: { id: projectId, userId: user.id },
  });
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const connectedAgents = realtimeHub.getAgentsForUser(
    user.id
  ) as ConnectedAgent[];
  const hasTaskTypeField = hasBodyField(normalizedBody, "task_type", "taskType");
  const rawTaskType = readBodyField(normalizedBody, "task_type", "taskType");
  if (hasTaskTypeField && parseTaskType(rawTaskType) === null) {
    return NextResponse.json({ error: "invalid task_type" }, { status: 400 });
  }
  const taskType = normalizeTaskType(rawTaskType);
  const requestedBackendType = normalizeBackendType(
    readBodyField(normalizedBody, "backend_type", "backendType")
  );
  const requestedSessionId = normalizeOptionalString(
    readBodyField(normalizedBody, "session_id", "sessionId")
  );
  const requestedSessionFilePath = normalizeOptionalString(
    readBodyField(normalizedBody, "session_file_path", "sessionFilePath")
  );
  const initialContent = normalizeOptionalString(
    readBodyField(normalizedBody, "initial_content", "initialContent")
  );
  const launchConfigField = parseJsonField(normalizedBody, "launch_config", "launchConfig");
  if (
    launchConfigField.hasField &&
    launchConfigField.raw != null &&
    launchConfigField.value === null
  ) {
    return NextResponse.json({ error: "launch_config must be an object" }, { status: 400 });
  }
  let launchConfig = launchConfigField.value;
  if (taskType === "ai_task") {
    const aiLaunchConfig = {
      ...(launchConfig ?? {}),
      ...(requestedBackendType && launchConfig?.backendType === undefined
        ? { backendType: requestedBackendType }
        : {}),
      ...(initialContent && launchConfig?.initialContent === undefined
        ? { initialContent }
        : {}),
      ...(requestedSessionId && launchConfig?.resumeSessionId === undefined
        ? { resumeSessionId: requestedSessionId }
        : {}),
      ...(requestedSessionFilePath && launchConfig?.sessionFilePath === undefined
        ? { sessionFilePath: requestedSessionFilePath }
        : {}),
    };
    launchConfig = Object.keys(aiLaunchConfig).length > 0 ? aiLaunchConfig : null;
  }
  if (taskType === "pty_task") {
    const launchConfigError = validatePtyLaunchConfig(launchConfig);
    if (launchConfigError) {
      return NextResponse.json({ error: launchConfigError }, { status: 400 });
    }
  }
  let agentHost = normalizeOptionalString(
    readBodyField(normalizedBody, "agent_host", "agentHost")
  );
  if (taskType === "pty_task") {
    const resolvedPtyAgent = resolvePtyAgentHost({
      connectedAgents,
      requestedAgentHost: agentHost,
      requestedBackendType,
      launchConfig,
    });
    if ("error" in resolvedPtyAgent) {
      return NextResponse.json({ error: resolvedPtyAgent.error }, { status: resolvedPtyAgent.status });
    }
    agentHost = resolvedPtyAgent.agentHost;
  } else if (!agentHost) {
    agentHost = pickDefaultAgentHost(connectedAgents, requestedBackendType) ?? null;
  }

  const planUser = await db.user.findUnique({
    where: { id: user.id },
    select: { subscriptionTier: true },
  });
  if (!planUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check task limits for all tiers (Free: 1 per bucket, Plus: 10 per bucket)
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
  await recoverStaleDisconnectedAgentTasks(user.id, activeTasks);
  const activeTaskCounts = countActiveTaskBuckets(activeTasks);
  const taskBucket = getTaskPlanBucket(agentHost);
  if (exceedsTaskLimit(planUser.subscriptionTier, taskBucket, activeTaskCounts)) {
    return NextResponse.json(
      {
        error: "Task limit reached",
        message: getTaskLimitMessage(planUser.subscriptionTier, taskBucket),
        limit_type:
          taskBucket === "manual_fire"
            ? "manual_fire_active_task"
            : "app_active_task",
      },
      { status: 403 }
    );
  }

  let metadata = parseJsonObject(normalizedBody.metadata);
  if (taskType === "ai_task" && metadata) {
    if (requestedBackendType && metadata.backendType === undefined) {
      metadata.backendType = requestedBackendType;
    }
    if (initialContent && metadata.initialContent === undefined) {
      metadata.initialContent = initialContent;
    }
  } else if (taskType === "ai_task" && !metadata && (requestedBackendType || initialContent)) {
    metadata = {
      ...(requestedBackendType ? { backendType: requestedBackendType } : {}),
      ...(initialContent ? { initialContent } : {}),
    };
  }
  const requestedId =
    typeof normalizedBody.id === "string" && normalizedBody.id.trim()
      ? normalizedBody.id
      : undefined;
  const title = normalizeOptionalString(normalizedBody.title) ?? "New Task";
  const defaultTaskStatus =
    taskType === "ai_task" && typeof agentHost === "string" && isConductorFireHost(agentHost)
      ? "running"
      : "unknown";

  let ptySession:
    | {
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
      }
    | undefined;
  let task;
  try {
    if (taskType === "pty_task") {
      const created = await createPtyTaskRecord({
        requestedId,
        projectId,
        title,
        status: normalizeTaskStatus(normalizedBody.status ?? defaultTaskStatus),
        agentHost,
        requestedBackendType,
        requestedSessionId,
        requestedSessionFilePath,
        launchConfig,
        metadata,
      });
      task = created.task;
      ptySession = created.ptySession;
    } else {
      task = await createTaskRecord({
        requestedId,
        projectId,
        title,
        taskType,
        status: normalizeTaskStatus(normalizedBody.status ?? defaultTaskStatus),
        agentHost,
        requestedBackendType,
        requestedSessionId,
        requestedSessionFilePath,
        launchConfig,
        metadata,
      });
    }
  } catch (error) {
    if (taskType === "pty_task" && isMissingPtySchemaError(error)) {
      return NextResponse.json({ error: PTY_SCHEMA_UNAVAILABLE_MESSAGE }, { status: 409 });
    }
    throw error;
  }

  let initialMessage: { id: string; createdAt: Date } | null = null;
  const initialMessageContent =
    taskType === "ai_task" &&
    typeof metadata?.initialContent === "string" &&
    metadata.initialContent.trim()
      ? metadata.initialContent.trim()
      : null;
  if (initialMessageContent) {
    [initialMessage] = await db.$transaction([
      db.message.create({
        data: {
          taskId: task.id,
          role: "user",
          content: initialMessageContent,
        },
      }),
      db.task.update({
        where: { id: task.id },
        data: { updatedAt: new Date() },
      }),
    ]);
    realtimeHub.broadcast(user.id, task.projectId, {
      type: "task_user_message",
      payload: {
        id: initialMessage.id,
        task_id: task.id,
        project_id: task.projectId,
        role: "user",
        content: initialMessageContent,
        created_at: initialMessage.createdAt.toISOString(),
      },
    });
  }

  if (taskType === "ai_task" && agentHost) {
    realtimeHub.bindTaskToAgent(task.id, agentHost);
    const requestId = randomUUID();
    await enqueueAndAttemptAgentCommand(
      {
        userId: user.id,
        agentHost,
        taskId: task.id,
        eventType: "create_task",
        requestId,
        envelope: {
          type: "create_task",
          payload: {
            task_id: task.id,
            project_id: task.projectId,
            title: task.title,
            backend_type: task.backendType ?? metadata?.backendType,
            initial_content: initialMessageContent ?? undefined,
            request_id: requestId,
          },
        },
      },
      {
        agentHost,
        sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
          realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
        resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
      },
    );
  }

  if (taskType === "pty_task" && agentHost && ptySession) {
    await dispatchPtyTaskCreation({
      userId: user.id,
      agentHost,
      task: task as { id: string; projectId: string; title: string },
      ptySessionId: ptySession.id,
      launchConfig,
      bindTaskToAgent: (taskId, boundAgentHost) =>
        realtimeHub.bindTaskToAgent(taskId, boundAgentHost),
      sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
        realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
      resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
    });
  }

  const taskResponseRecord = {
    ...task,
    ...(ptySession !== undefined || "ptySession" in task
      ? {
          ptySession:
            ptySession ?? (task as { ptySession?: Parameters<typeof serializePtySession>[0] }).ptySession ?? null,
        }
      : {}),
  };

  return NextResponse.json(serializeTaskResponse(taskResponseRecord));
}

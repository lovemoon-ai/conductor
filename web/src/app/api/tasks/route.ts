import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { getActiveSubscriptionUser } from "@/lib/auth/middleware";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { createAndDispatchAiTask } from "@/lib/tasks/create-ai-task";
import { serializeTaskResponse } from "@/lib/tasks/serialization";
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  normalizeTaskType,
  parseJsonObject,
  parseTaskType,
  serializeJsonObject,
  type JsonObject,
} from "@/lib/tasks/task-config";
import {
  buildTaskWorktreeLaunchConfig,
  isTaskWorktreeRequested,
} from "@/lib/tasks/worktree";
import {
  applyLegacyTaskShape,
  isMissingAnyNewSchemaError,
  isMissingPtySchemaError,
  legacyTaskSelect,
  PTY_SCHEMA_UNAVAILABLE_MESSAGE,
  taskSelectWithoutIssueId,
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
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import { recoverStaleDisconnectedAgentTasks } from "@/lib/tasks/stale-recovery";

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
      })).map((task) => ({ ...applyLegacyTaskShape(task), issueId: null })),
    async () =>
      (await db.task.findMany({
        where: {
          project: { userId },
          ...(projectId ? { projectId } : {}),
        },
        select: {
          ...taskSelectWithoutIssueId,
          ptySession: true,
        },
      })).map((task) => ({ ...task, issueId: null })),
  );

const getTaskListSortTime = (task: { updatedAt?: Date | null; createdAt: Date }) =>
  (task.updatedAt instanceof Date ? task.updatedAt : task.createdAt).getTime();

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
  const defaultProject = await db.defaultProject.findUnique({
    where: { userId: user.id },
    select: { projectId: true },
  });
  const isDefaultProject = defaultProject?.projectId === project.id;
  const projectDaemonHost = normalizeOptionalString((project as { daemonHost?: string | null }).daemonHost);
  const projectWorkspacePath = normalizeOptionalString((project as { workspacePath?: string | null }).workspacePath);
  const projectRepoRoot = normalizeOptionalString((project as { repoRoot?: string | null }).repoRoot);
  const projectWorktreeBranch = normalizeOptionalString((project as { worktreeBranch?: string | null }).worktreeBranch);
  const projectLastCommit = normalizeOptionalString((project as { lastCommit?: string | null }).lastCommit);
  if (
    (!isDefaultProject && (!projectDaemonHost || !projectWorkspacePath)) ||
    (projectDaemonHost && !projectWorkspacePath) ||
    (!projectDaemonHost && projectWorkspacePath)
  ) {
    return NextResponse.json({ error: "Project binding incomplete" }, { status: 409 });
  }

  const connectedAgents = realtimeHub.getAgentsForUser(
    user.id
  ) as ConnectedAgent[];
  const requestAgentHost = normalizeOptionalString(
    readBodyField(normalizedBody, "agent_host", "agentHost")
  );
  const isFireHostRequest = isConductorFireHost(requestAgentHost);
  if (
    projectDaemonHost &&
    !isFireHostRequest &&
    !connectedAgents.some((agent) => agent.host === projectDaemonHost)
  ) {
    return NextResponse.json(
      { error: `Project daemon ${projectDaemonHost} is offline` },
      { status: 409 },
    );
  }
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
  const worktreeRequested = isTaskWorktreeRequested(launchConfig);
  if (taskType === "pty_task" && worktreeRequested) {
    return NextResponse.json({ error: "PTY task does not support worktree" }, { status: 400 });
  }
  const requestedId =
    typeof normalizedBody.id === "string" && normalizedBody.id.trim()
      ? normalizedBody.id
      : worktreeRequested
        ? randomUUID()
        : undefined;
  if (worktreeRequested && (!projectDaemonHost || !projectWorkspacePath || !projectRepoRoot)) {
    return NextResponse.json(
      { error: "Worktree requires a git-backed bound project" },
      { status: 409 },
    );
  }
  if (taskType === "ai_task") {
    const aiLaunchConfig: JsonObject = {
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
    if (worktreeRequested) {
      try {
        launchConfig = buildTaskWorktreeLaunchConfig({
          launchConfig: aiLaunchConfig,
          worktreeId: requestedId!,
          projectRepoRoot: projectRepoRoot!,
          projectWorkspacePath: projectWorkspacePath!,
          projectWorktreeBranch,
          projectLastCommit,
        });
      } catch (error) {
        return NextResponse.json(
          { error: error instanceof Error ? error.message : "Invalid worktree request" },
          { status: 409 },
        );
      }
    } else {
      if (projectWorkspacePath) {
        aiLaunchConfig.cwd = projectWorkspacePath;
      }
      if (projectWorktreeBranch) {
        aiLaunchConfig.worktreeBranch = projectWorktreeBranch;
      }
      launchConfig = Object.keys(aiLaunchConfig).length > 0 ? aiLaunchConfig : null;
    }
  }
  if (taskType === "pty_task" && projectWorkspacePath && launchConfig?.cwd === undefined) {
    launchConfig = { ...(launchConfig ?? {}), cwd: projectWorkspacePath };
  }
  if (taskType === "pty_task") {
    const launchConfigError = validatePtyLaunchConfig(launchConfig);
    if (launchConfigError) {
      return NextResponse.json({ error: launchConfigError }, { status: 400 });
    }
  }
  const hasAgentHostField = hasBodyField(normalizedBody, "agent_host", "agentHost");
  let agentHost = normalizeOptionalString(
    readBodyField(normalizedBody, "agent_host", "agentHost")
  );
  if (projectDaemonHost) {
    if (hasAgentHostField && agentHost && agentHost !== projectDaemonHost) {
      if (!isConductorFireHost(agentHost)) {
        return NextResponse.json(
          { error: `Project daemon ${projectDaemonHost} must be used for this task` },
          { status: 409 },
        );
      }
      // Fire host: keep fire's own agentHost for independent routing.
      // The associated daemon is preserved in task metadata.daemonName.
    } else {
      agentHost = projectDaemonHost;
    }
  }
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


  const fireTaskDaemonName =
    isConductorFireHost(agentHost) && projectDaemonHost ? projectDaemonHost : null;

  let metadata = parseJsonObject(normalizedBody.metadata);
  if (taskType === "ai_task" && metadata) {
    if (requestedBackendType && metadata.backendType === undefined) {
      metadata.backendType = requestedBackendType;
    }
    if (initialContent && metadata.initialContent === undefined) {
      metadata.initialContent = initialContent;
    }
    if (fireTaskDaemonName && metadata.daemonName === undefined) {
      metadata.daemonName = fireTaskDaemonName;
    }
  } else if (taskType === "ai_task" && !metadata && (requestedBackendType || initialContent || fireTaskDaemonName)) {
    metadata = {
      ...(requestedBackendType ? { backendType: requestedBackendType } : {}),
      ...(initialContent ? { initialContent } : {}),
      ...(fireTaskDaemonName ? { daemonName: fireTaskDaemonName } : {}),
    };
  }
  const title = normalizeOptionalString(normalizedBody.title) ?? "New Task";
  const defaultTaskStatus =
    taskType === "ai_task" && typeof agentHost === "string" && isConductorFireHost(agentHost)
      ? "running"
      : "init";
  const initialMessageContent =
    taskType === "ai_task" &&
    typeof metadata?.initialContent === "string" &&
    metadata.initialContent.trim()
      ? metadata.initialContent.trim()
      : null;

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
      task = await createAndDispatchAiTask({
        userId: user.id,
        projectId,
        issueId: null,
        title,
        agentHost,
        requestedId,
        requestedBackendType,
        requestedSessionId,
        requestedSessionFilePath,
        launchConfig,
        metadata,
        initialMessageContent,
        status: normalizeTaskStatus(normalizedBody.status ?? defaultTaskStatus),
      });
    }
  } catch (error) {
    if (taskType === "pty_task" && isMissingPtySchemaError(error)) {
      return NextResponse.json({ error: PTY_SCHEMA_UNAVAILABLE_MESSAGE }, { status: 409 });
    }
    if (isMissingAnyNewSchemaError(error)) {
      // Missing issue_id column should not block task creation — PTY schema is present
      throw error;
    }
    throw error;
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

  const taskResponseRecord = ptySession ? { ...task, ptySession } : task;

  return NextResponse.json(serializeTaskResponse(taskResponseRecord));
}

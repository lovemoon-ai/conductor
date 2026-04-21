import { randomUUID } from "crypto";
import { getMessageAttachments } from "@/shared/utils/message-attachments";
import { db } from "@/lib/db";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  isConductorFireHost,
} from "@/lib/subscription/plan-limits";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";
import { projectTaskMessage } from "./task-event-projector";

type ConnectedAgent = {
  id: string;
  host: string;
  supportedBackends: string[];
};

export class TaskIngressError extends Error {
  code: string;
  status: number;
  details?: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "TaskIngressError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const normalizeBackendType = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const supportsBackend = (agent: ConnectedAgent, backendType: string): boolean =>
  agent.supportedBackends.some(
    (supported) => supported.trim().toLowerCase() === backendType,
  );

function pickDefaultAgentHost(
  agents: ConnectedAgent[],
  requestedBackendType: unknown,
): string | undefined {
  if (agents.length === 0) return undefined;

  const backendType = normalizeBackendType(requestedBackendType);

  const findHost = (
    predicate: (agent: ConnectedAgent) => boolean,
  ): string | undefined => agents.find(predicate)?.host;

  return (
    (backendType
      ? findHost(
          (agent) =>
            !isConductorFireHost(agent.host) &&
            supportsBackend(agent, backendType),
        )
      : undefined) ||
    (backendType
      ? findHost((agent) => supportsBackend(agent, backendType))
      : undefined) ||
    findHost(
      (agent) =>
        !isConductorFireHost(agent.host) && agent.supportedBackends.length > 0,
    ) ||
    findHost((agent) => !isConductorFireHost(agent.host)) ||
    agents[0].host
  );
}

function buildOutboxDeliveryOptions(agentHost: string | null) {
  return {
    agentHost,
    sendToAgentHost: ({
      userId,
      agentHost: targetAgentHost,
      envelope,
    }: {
      userId: string;
      agentHost: string;
      envelope: { type: string; payload: Record<string, unknown> };
    }) => realtimeHub.sendToAgentHost(userId, targetAgentHost, envelope),
    resolveTaskHost: (taskId: string) => realtimeHub.getTaskAgentHost(taskId),
  };
}

const resolveTaskUserMessageFireHost = (task: {
  agentHost?: string | null;
  executionHost?: string | null;
}, boundHost: string | null): string | null => {
  const configuredAgentHost = normalizeOptionalString(task.agentHost);
  const executionHost = normalizeOptionalString(task.executionHost);
  const normalizedBoundHost = normalizeOptionalString(boundHost);
  const isManualFireTask = Boolean(configuredAgentHost && isConductorFireHost(configuredAgentHost));
  const executionFireHost = executionHost && isConductorFireHost(executionHost) ? executionHost : null;
  const configuredFireHost = configuredAgentHost && isConductorFireHost(configuredAgentHost) ? configuredAgentHost : null;
  const boundFireHost =
    normalizedBoundHost &&
    isConductorFireHost(normalizedBoundHost) &&
    (normalizedBoundHost === executionFireHost || normalizedBoundHost === configuredFireHost)
      ? normalizedBoundHost
      : null;

  return isManualFireTask
    ? boundFireHost || executionFireHost || configuredFireHost
    : executionFireHost;
};

export async function createTaskForUser(input: {
  userId: string;
  projectId: string;
  id?: string;
  title?: string | null;
  status?: string | null;
  agentHost?: string | null;
  backendType?: string | null;
  sessionId?: string | null;
  sessionFilePath?: string | null;
  metadata?: Record<string, unknown> | null;
  initialContent?: string | null;
}): Promise<{
  task: Awaited<ReturnType<typeof db.task.create>>;
  initialMessage: Awaited<ReturnType<typeof db.message.create>> | null;
}> {
  const project = await db.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
  });
  if (!project) {
    throw new TaskIngressError("PROJECT_NOT_FOUND", 404, "Project not found", {
      error: "Project not found",
    });
  }
  const projectWorkspacePath = normalizeOptionalString(
    (project as { workspacePath?: string | null }).workspacePath,
  );
  const projectDaemonHost = normalizeOptionalString(
    (project as { daemonHost?: string | null }).daemonHost,
  );
  const projectWorktreeBranch = normalizeOptionalString(
    (project as { worktreeBranch?: string | null }).worktreeBranch,
  );

  const connectedAgents = realtimeHub.getAgentsForUser(input.userId) as ConnectedAgent[];
  const requestedBackendType = normalizeBackendType(input.backendType);
  const requestedSessionId = normalizeOptionalString(input.sessionId);
  const requestedSessionFilePath = normalizeOptionalString(input.sessionFilePath);
  let agentHost = projectDaemonHost ?? input.agentHost ?? null;
  if (!agentHost) {
    agentHost = pickDefaultAgentHost(connectedAgents, requestedBackendType) ?? null;
  }

  let metadata = input.metadata ?? null;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    if (requestedBackendType && metadata.backendType === undefined) {
      metadata.backendType = requestedBackendType;
    }
    if (input.initialContent && metadata.initialContent === undefined) {
      metadata.initialContent = input.initialContent;
    }
  } else if (!metadata && (requestedBackendType || input.initialContent)) {
    metadata = {
      ...(requestedBackendType ? { backendType: requestedBackendType } : {}),
      ...(input.initialContent ? { initialContent: input.initialContent } : {}),
    };
  }

  const launchConfig = {
    ...(requestedBackendType ? { backendType: requestedBackendType } : {}),
    ...(input.initialContent ? { initialContent: input.initialContent } : {}),
    ...(requestedSessionId ? { resumeSessionId: requestedSessionId } : {}),
    ...(requestedSessionFilePath ? { sessionFilePath: requestedSessionFilePath } : {}),
    ...(projectWorkspacePath ? { cwd: projectWorkspacePath } : {}),
    ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
  };
  const serializedLaunchConfig =
    Object.keys(launchConfig).length > 0 ? JSON.stringify(launchConfig) : null;

  const task = await db.task.create({
    data: {
      id: input.id,
      projectId: input.projectId,
      title: input.title || "New Task",
      status: normalizeTaskStatus(
        input.status ||
          (typeof agentHost === "string" && isConductorFireHost(agentHost)
            ? "running"
            : "unknown"),
      ),
      agentHost,
      executionHost: agentHost ?? null,
      backendType: requestedBackendType,
      sessionId: requestedSessionId,
      sessionFilePath: requestedSessionFilePath,
      launchConfig: serializedLaunchConfig,
      metadata: metadata ? JSON.stringify(metadata) : null,
    },
  });

  let initialMessage: Awaited<ReturnType<typeof db.message.create>> | null = null;
  const initialContent =
    typeof metadata?.initialContent === "string" && metadata.initialContent.trim()
      ? metadata.initialContent.trim()
      : null;
  if (initialContent) {
    [initialMessage] = await db.$transaction([
      db.message.create({
        data: {
          taskId: task.id,
          role: "user",
          content: initialContent,
        },
      }),
      db.task.update({
        where: { id: task.id },
        data: { updatedAt: new Date() },
      }),
    ]);
    await projectTaskMessage({
      userId: input.userId,
      projectId: task.projectId,
      message: initialMessage,
    });
  }

  if (agentHost) {
    realtimeHub.bindTaskToAgent(task.id, agentHost);
    const requestId = randomUUID();
    await enqueueAndAttemptAgentCommand(
      {
        userId: input.userId,
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
            initial_content: initialContent ?? undefined,
            launch_config: serializedLaunchConfig ? launchConfig : undefined,
            request_id: requestId,
          },
        },
      },
      buildOutboxDeliveryOptions(agentHost),
    );
  }

  return { task, initialMessage };
}

export async function appendUserMessageToTask(input: {
  userId: string;
  taskId: string;
  content: string;
  role?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<{
  task: Awaited<ReturnType<typeof db.task.findFirst>>;
  message: Awaited<ReturnType<typeof db.message.create>>;
}> {
  const task = await db.task.findFirst({
    where: { id: input.taskId, project: { userId: input.userId } },
  });
  if (!task) {
    throw new TaskIngressError("TASK_NOT_FOUND", 404, "Not found", {
      error: "Not found",
    });
  }
  const normalizedInputRole = String(input.role ?? "sdk").trim().toLowerCase();
  const userMessageTargetHost =
    normalizedInputRole === "user"
      ? resolveTaskUserMessageFireHost(task, realtimeHub.getTaskAgentHost(input.taskId))
      : null;
  if (normalizedInputRole === "user" && !userMessageTargetHost) {
    throw new TaskIngressError(
      "TASK_MISSING_ACTIVE_FIRE_OWNER",
      409,
      "Task missing active fire owner",
      {
        error: "Task missing active fire owner",
        message: "The task is not connected to an active fire owner. Try again after it reconnects.",
      },
    );
  }

  const [message] = await db.$transaction([
    db.message.create({
      data: {
        taskId: input.taskId,
        role: input.role ?? "sdk",
        content: input.content,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
      },
    }),
    db.task.update({
      where: { id: input.taskId },
      data: { updatedAt: new Date() },
    }),
  ]);

  await projectTaskMessage({
    userId: input.userId,
    projectId: task.projectId,
    message,
  });

  if (normalizedInputRole === "user") {
    const targetHost = userMessageTargetHost;
    const requestId = message.id;

    await enqueueAndAttemptAgentCommand(
      {
        userId: input.userId,
        agentHost: targetHost,
        taskId: task.id,
        eventType: "task_user_message",
        requestId,
        envelope: {
          type: "task_user_message",
          payload: {
            request_id: requestId,
            message_id: message.id,
            task_id: message.taskId,
            project_id: task.projectId,
            role: "user",
            content: message.content,
            created_at: message.createdAt.toISOString(),
            metadata: input.metadata ?? undefined,
            attachments: getMessageAttachments(input.metadata),
          },
        },
      },
      buildOutboxDeliveryOptions(targetHost),
    );
  }

  return { task, message };
}

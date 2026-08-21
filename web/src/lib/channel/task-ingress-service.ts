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
import { signAttachmentTransferToken } from "@/lib/tasks/attachment-transfer-token";

type ConnectedAgent = {
  id: string;
  host: string;
  supportedBackends: string[];
  capabilities?: string[];
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

const isUniqueConstraintError = (error: unknown): boolean =>
  (error as { code?: unknown })?.code === "P2002";

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
  clientMessageId?: string | null;
  metadata?: Record<string, unknown> | null;
  attachmentIds?: string[];
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
  if ((task as { achievedAt?: Date | null }).achievedAt) {
    throw new TaskIngressError(
      "TASK_ARCHIVED",
      409,
      "Archived tasks are read-only",
      {
        error: "Task archived",
        message: "Recover the archived task before sending new messages.",
      },
    );
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
        // Stable machine code so clients can detect this specific transient
        // startup race (task is `running` but its fire owner has not bound yet)
        // and auto-retry, rather than string-matching the human message.
        code: "task_missing_active_fire_owner",
        error: "Task missing active fire owner",
        message: "The task is not connected to an active fire owner. Try again after it reconnects.",
      },
    );
  }

  const clientMessageId = normalizeOptionalString(input.clientMessageId);
  const attachmentIds = Array.from(new Set((input.attachmentIds ?? [])
    .map((value) => normalizeOptionalString(value))
    .filter((value): value is string => Boolean(value))));
  if (attachmentIds.length > 20) {
    throw new TaskIngressError("TOO_MANY_ATTACHMENTS", 400, "A message can contain at most 20 attachments", {
      error: "Too many attachments",
    });
  }
  if (attachmentIds.length > 0) {
    const targetAgent = realtimeHub.getAgentsForUser(input.userId)
      .find((agent) => agent.host === userMessageTargetHost);
    const supportsAttachments = targetAgent?.capabilities
      .some((capability) => capability.trim().toLowerCase() === "task_attachments_v1");
    if (!supportsAttachments) {
      throw new TaskIngressError("ATTACHMENTS_UNSUPPORTED_BY_AGENT", 409, "Connected agent does not support attachments", {
        error: "Agent upgrade required",
        message: "Upgrade and reconnect Conductor on the target machine before sending attachments.",
      });
    }
  }
  const attachmentBindingTime = new Date();
  const attachments = attachmentIds.length
    ? await db.taskAttachment.findMany({
        where: {
          id: { in: attachmentIds }, taskId: input.taskId, messageId: null,
          status: "uploaded", expiresAt: { gt: attachmentBindingTime },
        },
      })
    : [];
  if (attachments.length !== attachmentIds.length) {
    throw new TaskIngressError("INVALID_ATTACHMENTS", 409, "One or more attachments are missing or already bound", {
      error: "Invalid attachments",
    });
  }
  const orderedAttachments = attachmentIds.map((id) => attachments.find((entry) => entry.id === id)!);
  const nativeImageTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  if (normalizeBackendType((task as { backendType?: unknown }).backendType) === "chat-web"
      && orderedAttachments.some((entry) => !nativeImageTypes.has(entry.mimeType.toLowerCase()))) {
    throw new TaskIngressError("CONTEXT_FILES_UNSUPPORTED_BY_BACKEND", 409, "The selected backend does not support context files", {
      error: "Context files unsupported",
      message: "Chat Web does not support ordinary file context. Remove the file or select another backend.",
    });
  }
  const imageBytes = orderedAttachments
    .filter((entry) => nativeImageTypes.has(entry.mimeType.toLowerCase()))
    .reduce((total, entry) => total + entry.sizeBytes, 0);
  const contextBytes = orderedAttachments
    .filter((entry) => !nativeImageTypes.has(entry.mimeType.toLowerCase()))
    .reduce((total, entry) => total + entry.sizeBytes, 0);
  if (orderedAttachments.some((entry) => nativeImageTypes.has(entry.mimeType.toLowerCase()) && entry.sizeBytes > 20 * 1024 * 1024)
      || imageBytes > 100 * 1024 * 1024
      || contextBytes > 200 * 1024 * 1024) {
    throw new TaskIngressError("ATTACHMENT_LIMIT_EXCEEDED", 413, "Attachment size limit exceeded", {
      error: "Attachment size limit exceeded",
    });
  }
  const attachmentDeliveryMetadata = orderedAttachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    kind: attachment.kind,
    sha256: attachment.sha256,
    status: "bound",
    downloadUrl: `/api/tasks/${encodeURIComponent(input.taskId)}/attachments/${encodeURIComponent(attachment.id)}`,
    createdAt: attachment.createdAt.toISOString(),
    transferToken: signAttachmentTransferToken({
      taskId: input.taskId,
      attachmentId: attachment.id,
      agentHost: userMessageTargetHost!,
    }),
  }));
  const attachmentMetadata = attachmentDeliveryMetadata.map(({ transferToken: _transferToken, ...attachment }) => attachment);
  const callerMetadata = input.metadata ? { ...input.metadata } : null;
  if (callerMetadata) delete callerMetadata.attachments;
  const finalMetadata = attachmentMetadata.length
    ? { ...(callerMetadata ?? {}), attachments: attachmentMetadata }
    : callerMetadata;
  const messageData = {
    taskId: input.taskId,
    role: input.role ?? "sdk",
    content: input.content,
    metadata: finalMetadata ? JSON.stringify(finalMetadata) : null,
    ...(clientMessageId ? { clientMessageId } : {}),
  };

  const buildUserMessageEnvelope = (created: { id: string; taskId: string; content: string; createdAt: Date }) => ({
    type: "task_user_message",
    payload: {
      request_id: created.id,
      message_id: created.id,
      task_id: created.taskId,
      project_id: task.projectId,
      role: "user",
      content: created.content,
      created_at: created.createdAt.toISOString(),
      metadata: finalMetadata ?? undefined,
      attachments: attachmentDeliveryMetadata,
      ...(attachmentDeliveryMetadata.length ? { required_capabilities: ["task_attachments_v1"] } : {}),
    },
  });

  let message: Awaited<ReturnType<typeof db.message.create>>;
  let createdMessage = true;
  try {
    message = await db.$transaction(async (tx) => {
      const created = await tx.message.create({ data: messageData });
      if (attachmentIds.length) {
        const bound = await tx.taskAttachment.updateMany({
          where: {
            id: { in: attachmentIds }, taskId: input.taskId, messageId: null,
            status: "uploaded", expiresAt: { gt: attachmentBindingTime },
          },
          data: { messageId: created.id, status: "bound", boundAt: new Date(), expiresAt: null },
        });
        if (bound.count !== attachmentIds.length) {
          throw new TaskIngressError("ATTACHMENT_BIND_RACE", 409, "Attachments were bound by another message", {
            error: "Attachment binding conflict",
          });
        }
      }
      await tx.task.update({ where: { id: input.taskId }, data: { updatedAt: new Date() } });
      // Attachment binding and its downstream command are one atomic unit. If
      // the outbox cannot be written, the transaction rolls back and the same
      // uploaded attachment remains reusable by the client.
      if (attachmentIds.length && normalizedInputRole === "user") {
        await tx.agentOutbox.create({
          data: {
            userId: input.userId,
            agentHost: userMessageTargetHost,
            taskId: task.id,
            eventType: "task_user_message",
            requestId: created.id,
            payloadJson: JSON.stringify(buildUserMessageEnvelope(created)),
            status: "pending",
            attemptCount: 0,
            nextRetryAt: null,
          },
        });
      }
      return created;
    });
  } catch (error) {
    if (!clientMessageId || !isUniqueConstraintError(error)) {
      throw error;
    }
    const existingMessage = await db.message.findFirst({
      where: {
        taskId: input.taskId,
        clientMessageId,
      },
    });
    if (!existingMessage) {
      throw error;
    }
    message = existingMessage;
    createdMessage = false;
    await db.task.update({
      where: { id: input.taskId },
      data: { updatedAt: new Date() },
    });
  }

  if (createdMessage) {
    await projectTaskMessage({
      userId: input.userId,
      projectId: task.projectId,
      message,
    });
  }

  if (normalizedInputRole === "user") {
    const targetHost = userMessageTargetHost;
    const requestId = message.id;

    const delivery = enqueueAndAttemptAgentCommand(
      {
        userId: input.userId,
        agentHost: targetHost,
        taskId: task.id,
        eventType: "task_user_message",
        requestId,
        envelope: buildUserMessageEnvelope(message),
      },
      buildOutboxDeliveryOptions(targetHost),
    );
    if (attachmentIds.length) {
      // The durable row already committed with the message. A best-effort
      // immediate delivery failure must not turn a successful atomic enqueue
      // into an HTTP error that encourages the browser to duplicate the turn.
      await delivery.catch((error) => {
        console.warn(`[task-ingress] immediate attachment delivery failed for ${requestId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else {
      await delivery;
    }
  }

  return { task, message };
}

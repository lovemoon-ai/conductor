import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeMessageMetadata } from "@/shared/utils/message-attachments";
import {
  projectTaskMessage,
  projectTaskStatusUpdate,
} from "@/lib/channel/task-event-projector";
import {
  acknowledgeAgentCommand,
  deliverAgentOutboxForHost,
} from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";

type TaskOwnershipRecord = {
  id: string;
  agentHost: string | null;
  executionHost: string | null;
  taskType?: string | null;
};

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "init") return "init";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const sendEnvelopeToAgentHost = (args: {
  userId: string;
  agentHost: string;
  envelope: { type: string; payload: Record<string, unknown> };
}): boolean => realtimeHub.sendToAgentHost(args.userId, args.agentHost, args.envelope);

export async function drainAgentOutboxForHost(
  userId: string,
  agentHost: string,
  options: { ignoreRetryAt?: boolean } = {},
): Promise<void> {
  try {
    const result = await deliverAgentOutboxForHost({
      userId,
      agentHost,
      ignoreRetryAt: options.ignoreRetryAt === true,
      sendToAgentHost: sendEnvelopeToAgentHost,
      resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
    });
    if (result.attempted > 0) {
      console.log(
        `[agent-upstream] drained outbox for ${agentHost}: attempted=${result.attempted} delivered=${result.delivered}`,
      );
    }
  } catch (error) {
    console.error(
      `[agent-upstream] failed to drain outbox for ${agentHost}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function persistTaskExecutionHost(
  userId: string,
  taskId: string,
  agentHost: string,
): Promise<void> {
  const normalizedHost = agentHost.trim();
  if (!normalizedHost) return;
  await db.task.updateMany({
    where: {
      id: taskId,
      project: { userId },
      OR: [
        { executionHost: null },
        { executionHost: { not: normalizedHost } },
      ],
    },
    data: { executionHost: normalizedHost },
  });
}

const getAssignedTaskHost = (task: TaskOwnershipRecord): string | null =>
  normalizeOptionalString(task.executionHost) || normalizeOptionalString(task.agentHost);

const canFireHostClaimTask = (task: TaskOwnershipRecord, agentHost: string): boolean => {
  const daemonHost = normalizeOptionalString(task.agentHost);
  return (
    isConductorFireHost(agentHost) &&
    normalizeOptionalString(task.taskType) === "ai_task" &&
    Boolean(daemonHost) &&
    !isConductorFireHost(daemonHost)
  );
};

async function ensureAgentOwnsTaskRecord(
  userId: string,
  task: TaskOwnershipRecord,
  agentHost: string,
): Promise<void> {
  const assignedHost = getAssignedTaskHost(task);
  if (!assignedHost) {
    throw new Error(`Task ${task.id} has no assigned agent host`);
  }
  const allowFireHostClaim = assignedHost !== agentHost && canFireHostClaimTask(task, agentHost);
  if (!allowFireHostClaim && assignedHost !== agentHost) {
    throw new Error(`Task ${task.id} is assigned to ${assignedHost}, not ${agentHost}`);
  }

  const boundHost = realtimeHub.getTaskAgentHost(task.id);
  if (boundHost && boundHost !== agentHost && realtimeHub.hasAgentHost(boundHost, userId)) {
    if (allowFireHostClaim && !isConductorFireHost(boundHost)) {
      realtimeHub.bindTaskToAgent(task.id, agentHost);
      await persistTaskExecutionHost(userId, task.id, agentHost);
      return;
    }
    const ownerKind = isConductorFireHost(boundHost) ? "fire host" : "agent host";
    throw new Error(`Task ${task.id} is already handled by active ${ownerKind} ${boundHost}`);
  }

  realtimeHub.bindTaskToAgent(task.id, agentHost);
  await persistTaskExecutionHost(userId, task.id, agentHost);
}

async function ensureAgentOwnsTask(userId: string, taskId: string, agentHost: string): Promise<void> {
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId } },
    select: {
      id: true,
      agentHost: true,
      executionHost: true,
      taskType: true,
    },
  });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await ensureAgentOwnsTaskRecord(userId, task, agentHost);
}

async function getOwnedTask(userId: string, taskId: string, agentHost: string) {
  const task = await db.task.findFirst({
    where: { id: taskId, project: { userId } },
  });
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await ensureAgentOwnsTaskRecord(userId, task, agentHost);
  return task;
}

export async function commitSdkMessage(input: {
  userId: string;
  agentHost: string;
  taskId: string;
  content: string;
  metadata?: Record<string, unknown>;
  messageId?: string | null;
}): Promise<{ taskId: string; projectId: string; messageId: string | null; duplicate: boolean }> {
  const task = await getOwnedTask(input.userId, input.taskId, input.agentHost);
  await drainAgentOutboxForHost(input.userId, input.agentHost);
  const normalizedAgentHost = normalizeOptionalString(input.agentHost);
  const shouldPromoteInitTask = normalizeTaskStatus(task.status) === "init";

  const clientMessageId = normalizeOptionalString(input.messageId);
  let message: { id: string; createdAt: Date };
  let duplicate = false;

  if (clientMessageId) {
    const existingMessage = await db.message.findUnique({
      where: { clientMessageId },
      select: { id: true, createdAt: true },
    });
    if (existingMessage) {
      message = existingMessage;
      duplicate = true;
    } else {
      try {
        [message] = await db.$transaction([
          db.message.create({
            data: {
              taskId: task.id,
              role: "sdk",
              content: input.content,
              metadata: input.metadata ? JSON.stringify(input.metadata) : null,
              clientMessageId,
            },
            select: { id: true, createdAt: true },
          }),
          db.task.update({
            where: { id: task.id },
            data: {
              updatedAt: new Date(),
              ...(shouldPromoteInitTask ? { status: "running" } : {}),
              ...(shouldPromoteInitTask && normalizedAgentHost
                ? { executionHost: normalizedAgentHost }
                : {}),
            },
          }),
        ]);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const created = await db.message.findUnique({
            where: { clientMessageId },
            select: { id: true, createdAt: true },
          });
          if (!created) {
            throw error;
          }
          message = created;
          duplicate = true;
        } else {
          throw error;
        }
      }
    }
  } else {
    [message] = await db.$transaction([
      db.message.create({
        data: {
          taskId: task.id,
          role: "sdk",
          content: input.content,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        },
        select: { id: true, createdAt: true },
      }),
      db.task.update({
        where: { id: task.id },
        data: {
          updatedAt: new Date(),
          ...(shouldPromoteInitTask ? { status: "running" } : {}),
          ...(shouldPromoteInitTask && normalizedAgentHost
            ? { executionHost: normalizedAgentHost }
            : {}),
        },
      }),
    ]);
  }

  if (!duplicate) {
    if (shouldPromoteInitTask) {
      await projectTaskStatusUpdate({
        userId: input.userId,
        projectId: task.projectId,
        taskId: task.id,
        status: "running",
      });
    }
    await projectTaskMessage({
      userId: input.userId,
      projectId: task.projectId,
      message: {
        id: message.id,
        taskId: task.id,
        role: "sdk",
        content: input.content,
        createdAt: message.createdAt,
        metadata: normalizeMessageMetadata(input.metadata),
      },
    });
  }

  return {
    taskId: task.id,
    projectId: task.projectId,
    messageId: clientMessageId,
    duplicate,
  };
}

export async function commitTaskStatusUpdate(input: {
  userId: string;
  agentHost: string;
  taskId: string;
  status: string;
  summary?: string | null;
  statusEventId?: string | null;
}): Promise<{ taskId: string; projectId: string; status: string; duplicate: boolean }> {
  const task = await getOwnedTask(input.userId, input.taskId, input.agentHost);
  await drainAgentOutboxForHost(input.userId, input.agentHost);

  const status = normalizeTaskStatus(input.status);
  const summary = normalizeOptionalString(input.summary);
  const statusEventId = normalizeOptionalString(input.statusEventId);

  let duplicate = false;
  if (statusEventId) {
    const existing = await db.taskStatusEvent.findUnique({
      where: { statusEventId },
      select: { id: true },
    });
    if (existing) {
      duplicate = true;
    } else {
      try {
        await db.$transaction([
          db.taskStatusEvent.create({
            data: {
              taskId: task.id,
              statusEventId,
              status,
              summary,
            },
          }),
          db.task.update({
            where: { id: task.id },
            data: { status },
          }),
        ]);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          duplicate = true;
        } else {
          throw error;
        }
      }
    }
  } else {
    await db.task.update({
      where: { id: task.id },
      data: { status },
    });
  }

  if (!duplicate) {
    await projectTaskStatusUpdate({
      userId: input.userId,
      projectId: task.projectId,
      taskId: task.id,
      status,
      summary,
    });
  }

  return {
    taskId: task.id,
    projectId: task.projectId,
    status,
    duplicate,
  };
}

export async function commitAgentCommandAck(input: {
  userId: string;
  agentHost: string;
  requestId: string;
  taskId?: string | null;
  eventType?: string | null;
  accepted?: boolean;
}): Promise<{ requestId: string; accepted: boolean; duplicate: boolean }> {
  const requestId = normalizeOptionalString(input.requestId);
  if (!requestId) {
    throw new Error("request_id is required");
  }
  const taskId = normalizeOptionalString(input.taskId);
  if (taskId) {
    await ensureAgentOwnsTask(input.userId, taskId, input.agentHost);
  }
  await drainAgentOutboxForHost(input.userId, input.agentHost);
  const result = await acknowledgeAgentCommand({
    userId: input.userId,
    requestId,
    accepted: input.accepted !== false,
    eventType: normalizeOptionalString(input.eventType) || undefined,
  });
  return {
    requestId,
    accepted: input.accepted !== false,
    duplicate: result.count === 0,
  };
}

export async function commitTaskStopAck(input: {
  userId: string;
  agentHost: string;
  taskId: string;
  requestId: string;
  accepted?: boolean;
}): Promise<{ taskId: string; requestId: string; accepted: boolean; duplicate: boolean }> {
  const taskId = normalizeOptionalString(input.taskId);
  const requestId = normalizeOptionalString(input.requestId);
  if (!taskId || !requestId) {
    throw new Error("task_id and request_id are required");
  }
  await ensureAgentOwnsTask(input.userId, taskId, input.agentHost);
  const accepted = input.accepted !== false;
  realtimeHub.acknowledgeTaskStop(taskId, requestId, accepted);
  const result = await acknowledgeAgentCommand({
    userId: input.userId,
    requestId,
    accepted,
    eventType: "task_stop_ack",
  });
  return {
    taskId,
    requestId,
    accepted,
    duplicate: result.count === 0,
  };
}

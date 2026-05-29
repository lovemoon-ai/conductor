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
  isMissingAgentOutboxTableError,
} from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import {
  isMissingAnyNewSchemaError,
  taskSelectWithoutIssueId,
} from "@/lib/tasks/pty-compat";
import {
  buildKilledPatch,
  withKilledReasonFallback,
  type KilledReason,
} from "@/lib/tasks/killed-reason";

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
  if (normalized === "killing" || normalized === "stopping") return "killing";
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

const canFireHostClaimTask = (
  task: TaskOwnershipRecord,
  agentHost: string,
  options: { allowFireHostClaim?: boolean } = {},
): boolean => {
  if (options.allowFireHostClaim === false) {
    return false;
  }
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
  options: { allowFireHostClaim?: boolean } = {},
): Promise<void> {
  const assignedHost = getAssignedTaskHost(task);
  if (!assignedHost) {
    throw new Error(`Task ${task.id} has no assigned agent host`);
  }
  const allowFireHostClaim = assignedHost !== agentHost && canFireHostClaimTask(task, agentHost, options);
  if (!allowFireHostClaim && assignedHost !== agentHost) {
    throw new Error(`Task ${task.id} is assigned to ${assignedHost}, not ${agentHost}`);
  }

  const boundHost = realtimeHub.getTaskAgentHost(task.id);
  if (boundHost && boundHost !== agentHost && realtimeHub.hasAgentHost(boundHost, userId)) {
    const allowFireHostRebind =
      isConductorFireHost(agentHost) &&
      assignedHost === agentHost &&
      !isConductorFireHost(boundHost);
    if ((allowFireHostClaim || allowFireHostRebind) && !isConductorFireHost(boundHost)) {
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

async function ensureAgentOwnsTask(
  userId: string,
  taskId: string,
  agentHost: string,
  options: { allowFireHostClaim?: boolean } = {},
): Promise<void> {
  let task: TaskOwnershipRecord | null;
  try {
    task = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
      select: {
        id: true,
        agentHost: true,
        executionHost: true,
        taskType: true,
      },
    });
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) throw error;
    const partial = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
      select: {
        id: true,
        agentHost: true,
        executionHost: true,
      },
    });
    task = partial ? { ...partial, taskType: null } : null;
  }
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await ensureAgentOwnsTaskRecord(userId, task, agentHost, options);
}

async function getOwnedTask(userId: string, taskId: string, agentHost: string) {
  let task;
  try {
    task = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
    });
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) throw error;
    const partial = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
      select: { ...taskSelectWithoutIssueId },
    });
    task = partial ? { ...partial, issueId: null } : null;
  }
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await ensureAgentOwnsTaskRecord(userId, task, agentHost);
  return task;
}

type AgentCommandAckRow = {
  taskId: string | null;
  agentHost: string | null;
  eventType: string | null;
};

const isTaskNotFoundError = (error: unknown, taskId: string): boolean =>
  error instanceof Error && error.message === `Task ${taskId} not found`;

async function findAgentCommandAckRow(input: {
  userId: string;
  requestId: string;
}): Promise<AgentCommandAckRow | null> {
  try {
    return await db.agentOutbox.findFirst({
      where: {
        userId: input.userId,
        requestId: input.requestId,
      },
      select: {
        taskId: true,
        agentHost: true,
        eventType: true,
      },
    });
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      return null;
    }
    throw error;
  }
}

const matchesCommandAckRow = (
  row: AgentCommandAckRow | null,
  input: {
    agentHost: string;
    taskId: string;
    eventType: string | null;
  },
): boolean => {
  if (!row) return false;
  const rowTaskId = normalizeOptionalString(row.taskId);
  const rowAgentHost = normalizeOptionalString(row.agentHost);
  const rowEventType = normalizeOptionalString(row.eventType);

  if (rowTaskId && rowTaskId !== input.taskId) return false;
  if (rowAgentHost && rowAgentHost !== input.agentHost) return false;
  if (rowEventType && input.eventType && rowEventType !== input.eventType) return false;
  return Boolean(rowTaskId);
};

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
  const currentStatus = normalizeTaskStatus(task.status);
  if (currentStatus === "killing" && status !== "completed" && status !== "killed") {
    return {
      taskId: task.id,
      projectId: task.projectId,
      status: currentStatus,
      duplicate: false,
    };
  }

  // RFC 0029: decide the killed_reason discriminator when the daemon reports a
  // task transitioning into `killed`. If the previous status was `killing`,
  // the user (or an API consumer mirroring the user intent) explicitly asked
  // for the stop and we should NOT reclaim on the next restart. Any other
  // transition into `killed` means the fire/SDK side ended on its own —
  // tag it `fire_exit` (crashes are upstream of this hub event and get a
  // different label by their handler).
  const transitioningToKilled = status === "killed" && currentStatus !== "killed";
  const killedReason: KilledReason | null = transitioningToKilled
    ? currentStatus === "killing"
      ? "user_stopped"
      : "fire_exit"
    : null;
  const baseUpdateData: Record<string, unknown> = { status };
  const buildKilledUpdateData = (): Record<string, unknown> =>
    killedReason
      ? { ...baseUpdateData, ...buildKilledPatch(killedReason) }
      : baseUpdateData;

  let duplicate = false;
  if (statusEventId) {
    const existing = await db.taskStatusEvent.findUnique({
      where: { statusEventId },
      select: { id: true },
    });
    if (existing) {
      duplicate = true;
    } else {
      const runStatusEventTransaction = (taskData: Record<string, unknown>) =>
        db.$transaction([
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
            data: taskData,
          }),
        ]);
      try {
        if (transitioningToKilled) {
          await withKilledReasonFallback(
            () => runStatusEventTransaction(buildKilledUpdateData()),
            () => runStatusEventTransaction(baseUpdateData),
          );
        } else {
          await runStatusEventTransaction(baseUpdateData);
        }
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
  } else if (transitioningToKilled) {
    await withKilledReasonFallback(
      () =>
        db.task.update({
          where: { id: task.id },
          data: buildKilledUpdateData(),
        }),
      () =>
        db.task.update({
          where: { id: task.id },
          data: baseUpdateData,
        }),
    );
  } else {
    await db.task.update({
      where: { id: task.id },
      data: baseUpdateData,
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
  const eventType = normalizeOptionalString(input.eventType);
  const ackRow = taskId
    ? await findAgentCommandAckRow({
        userId: input.userId,
        requestId,
      })
    : null;
  let taskExists = true;
  if (taskId) {
    try {
      await ensureAgentOwnsTask(input.userId, taskId, input.agentHost, {
        allowFireHostClaim: eventType !== "interrupt_turn",
      });
    } catch (error) {
      if (
        !isTaskNotFoundError(error, taskId) ||
        !matchesCommandAckRow(ackRow, {
          agentHost: input.agentHost,
          taskId,
          eventType,
        })
      ) {
        throw error;
      }
      taskExists = false;
    }
  }
  const accepted = input.accepted !== false;
  if (taskId && taskExists) {
    realtimeHub.acknowledgeAgentCommand(taskId, requestId, accepted, {
      agentHost: input.agentHost,
      eventType: eventType || null,
    });
  }
  await drainAgentOutboxForHost(input.userId, input.agentHost);
  const result = await acknowledgeAgentCommand({
    userId: input.userId,
    requestId,
    accepted,
    eventType: eventType || undefined,
  });
  return {
    requestId,
    accepted,
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

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import { recoverStaleDisconnectedAgentTasks } from "@/lib/tasks/stale-recovery";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";

const STOP_TASK_ACK_TIMEOUT_MS = 2500;
const STOP_TASK_FINAL_STATUS_TIMEOUT_MS = 5000;
const STOP_TASK_POLL_TIMEOUT_MS = parsePositiveInt(
  process.env.CONDUCTOR_STOP_TASK_POLL_TIMEOUT_MS,
  60_000,
);
const STOP_TASK_POLL_INTERVAL_MS = parsePositiveInt(
  process.env.CONDUCTOR_STOP_TASK_POLL_INTERVAL_MS,
  process.env.NODE_ENV === "test" ? 1 : 1000,
);

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const normalizeHost = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const findTaskForStopConvergence = async (userId: string, taskId: string) =>
  db.task.findFirst({
    where: { id: taskId, project: { userId } },
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

const waitForTaskStopConvergence = async (args: {
  userId: string;
  taskId: string;
  stopTargetHost: string;
}): Promise<{ ok: boolean; status?: string; error?: string }> => {
  const deadline = Date.now() + STOP_TASK_POLL_TIMEOUT_MS;
  let recoveryTriggered = false;

  while (true) {
    const latestTask = await findTaskForStopConvergence(args.userId, args.taskId);
    if (!latestTask) {
      return { ok: false, error: `Task ${args.taskId} not found while waiting for stop` };
    }

    const latestStatus = normalizeTaskStatus(latestTask.status);
    if (latestStatus === "completed" || latestStatus === "killed") {
      return { ok: true, status: latestStatus };
    }

    const latestHost =
      normalizeHost(realtimeHub.getTaskAgentHost(args.taskId)) ||
      normalizeHost(latestTask.executionHost) ||
      normalizeHost(latestTask.agentHost) ||
      args.stopTargetHost;
    const hostActive = latestHost ? realtimeHub.hasAgentHost(latestHost, args.userId) : false;

    if (!hostActive && !recoveryTriggered) {
      recoveryTriggered = true;
      await recoverStaleDisconnectedAgentTasks(args.userId, [latestTask] as any);
      const recoveredTask = await findTaskForStopConvergence(args.userId, args.taskId);
      const recoveredStatus = normalizeTaskStatus(recoveredTask?.status);
      if (recoveredStatus === "completed" || recoveredStatus === "killed") {
        return { ok: true, status: recoveredStatus };
      }
    }

    if (Date.now() >= deadline) {
      return hostActive
        ? {
            ok: false,
            error: `Timed out waiting for task ${args.taskId} to stop on ${args.stopTargetHost}`,
          }
        : {
            ok: false,
            error: `task daemon ${latestHost || args.stopTargetHost} is offline`,
          };
    }

    await sleep(STOP_TASK_POLL_INTERVAL_MS);
  }
};

export const stopTaskBeforeRelaunch = async (args: {
  userId: string;
  taskId: string;
  projectId: string;
  stopTargetHost: string;
  reason: string;
  taskLabel?: string;
  requireActiveHost?: boolean;
}): Promise<{ ok: boolean; error?: string }> => {
  const hostActive = realtimeHub.hasAgentHost(args.stopTargetHost, args.userId);
  const taskLabel = args.taskLabel ?? "task";
  if (args.requireActiveHost && !hostActive) {
    return { ok: false, error: `${taskLabel} daemon ${args.stopTargetHost} is offline` };
  }

  const requestId = randomUUID();
  const previousBoundHost = normalizeHost(realtimeHub.getTaskAgentHost(args.taskId));
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
  const restoreTaskBinding = () => {
    if (previousBoundHost) {
      realtimeHub.bindTaskToAgent(args.taskId, previousBoundHost);
      return;
    }
    realtimeHub.unbindTask(args.taskId);
  };
  const cancelStopWaiters = () => {
    realtimeHub.cancelTaskStopAck(args.taskId, requestId);
    realtimeHub.cancelTaskFinalStatus(args.taskId);
  };

  let delivered = false;
  try {
    ({ delivered } = await enqueueAndAttemptAgentCommand(
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
    ));
  } catch (error) {
    cancelStopWaiters();
    restoreTaskBinding();
    return {
      ok: !hostActive,
      error: hostActive
        ? `Failed to stop running ${taskLabel} on ${args.stopTargetHost}: ${
            error instanceof Error ? error.message : String(error)
          }`
        : undefined,
    };
  }

  if (!delivered) {
    cancelStopWaiters();
    restoreTaskBinding();
    return hostActive
      ? { ok: false, error: `Failed to stop running ${taskLabel} on ${args.stopTargetHost}` }
      : { ok: true };
  }

  await ackPromise;
  const finalStatus = await finalStatusPromise;
  if (finalStatus === "completed" || finalStatus === "killed") {
    return { ok: true };
  }

  const convergenceResult = await waitForTaskStopConvergence({
    userId: args.userId,
    taskId: args.taskId,
    stopTargetHost: args.stopTargetHost,
  });
  if (convergenceResult.ok) {
    return { ok: true };
  }

  return {
    ok: false,
    error:
      convergenceResult.error ??
      (hostActive
        ? `Timed out waiting for ${taskLabel} ${args.taskId} to stop on ${args.stopTargetHost}`
        : `${taskLabel} daemon ${args.stopTargetHost} is offline`),
  };
};

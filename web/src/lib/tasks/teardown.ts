import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { deleteTaskAttachmentDirectory } from "@/lib/tasks/task-file-storage";
import { isMissingPtySchemaError } from "@/lib/tasks/pty-compat";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";
import {
  deletePtyTaskWithKill,
  findAttachedTerminalForAiTask,
} from "@/lib/tasks/attached-terminal";
import {
  acquireTaskWorktreeMutationLock,
  buildTaskWorktreeCleanupOutboxData,
  hasSameTaskWorktreeRoot,
  resolveTaskWorktreeCleanupHost,
  parseTaskWorktreeLaunchConfig,
} from "@/lib/tasks/worktree";

const normalizeHost = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

/**
 * The minimal shape `teardownTaskRuntime` needs. Callers should select exactly
 * these columns so the teardown decisions (which host to stop, whether a
 * worktree exists) stay consistent with the DELETE handler.
 */
export interface TeardownTaskInput {
  id: string;
  projectId: string;
  taskType: string | null;
  agentHost: string | null;
  executionHost: string | null;
  status: string | null;
  launchConfig: string | null;
  metadata: string | null;
  project?: { daemonHost?: string | null } | null;
}

export interface TeardownTaskResult {
  ok: boolean;
  /** HTTP-ish status hint for the caller (e.g. 409 on attached-terminal leak). */
  status?: number;
  error?: string;
}

/**
 * Tears down everything that makes a task "live" — mirroring the DELETE handler
 * for the runtime side — WITHOUT removing the `Message` transcript or the `Task`
 * row itself. Used by the "achieve"/pack flow so a packed task keeps its chat
 * history for later search while its daemon session and runtime state are gone.
 *
 * What it does (each step best-effort, in this order):
 *  1. Kill an attached PTY task first (so its agent process gets the signal
 *     before its AttachedTerminal row would cascade away). Hard failure here
 *     returns { ok: false, status: 409 } so the caller can refuse and retry.
 *  2. Best-effort `stop_task` to the daemon (does NOT block on convergence).
 *  3. Cancel active schedules, delete runtime rows, stamp the task achieved,
 *     and enqueue async worktree cleanup unless an active task still shares
 *     the root. (AttachedTerminal is already gone via step 1's cascade.)
 *  4. Optionally delete the on-disk attachment directory.
 *  5. Unbind the task from its agent in the realtime hub.
 *
 * NOTE: kept intentionally parallel to the DELETE handler in
 * `app/api/tasks/[taskId]/route.ts`. The DELETE handler additionally removes
 * `Message` rows and the `Task` row inside its worktree transaction; teardown
 * deliberately stops short of that.
 */
export async function teardownTaskRuntime(args: {
  userId: string;
  task: TeardownTaskInput;
  reason: string;
  /**
   * Final Task patch applied in the same transaction as runtime teardown.
   * Keeping this atomic prevents two concurrently archived tasks that share a
   * worktree from both observing the other as active and skipping cleanup.
   */
  archivePatch: {
    achievedAt: Date;
    status?: string;
    killedReason?: string;
    killedAt?: Date;
  };
  /** Delete the on-disk attachment directory. Archive passes false to keep
   * attachments referenced by the preserved transcript. */
  deleteAttachmentDirectory?: boolean;
}): Promise<TeardownTaskResult> {
  const { userId, task, reason } = args;
  const taskId = task.id;
  const taskType = task.taskType ?? "ai_task";

  // 1. Attached terminal: kill the PTY task first (see DELETE handler contract).
  if (taskType === "ai_task") {
    const attached = await findAttachedTerminalForAiTask(taskId);
    if (attached) {
      try {
        await deletePtyTaskWithKill({ userId, ptyTaskId: attached.ptyTaskId });
      } catch (primaryError) {
        console.error(
          `[teardown] deletePtyTaskWithKill failed: aiTaskId=${taskId}, ptyTaskId=${attached.ptyTaskId}, error=${
            primaryError instanceof Error ? primaryError.message : String(primaryError)
          }`,
        );
        try {
          await db.task.delete({ where: { id: attached.ptyTaskId } });
        } catch (fallbackError) {
          if ((fallbackError as { code?: unknown })?.code !== "P2025") {
            console.error(
              `[teardown] fallback PTY row delete also failed: aiTaskId=${taskId}, ptyTaskId=${attached.ptyTaskId}, error=${
                fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
              }`,
            );
            return {
              ok: false,
              status: 409,
              error:
                "Failed to clean up the attached terminal; please retry.",
            };
          }
        }
      }
    }
  }

  // 2. Decide whether a daemon stop is needed and resolve the target host.
  const normalizedStatus = normalizeTaskStatus(task.status);
  const needsStop =
    normalizedStatus === "running" ||
    normalizedStatus === "killing" ||
    normalizedStatus === "unknown";
  const boundHost = normalizeHost(realtimeHub.getTaskAgentHost(taskId));
  const worktreeConfig =
    taskType === "ai_task" ? parseTaskWorktreeLaunchConfig(task.launchConfig) : null;
  const worktreeCleanupHost = resolveTaskWorktreeCleanupHost({
    boundHost,
    agentHost: task.agentHost,
    executionHost: task.executionHost,
    metadata: task.metadata,
    projectDaemonHost: task.project?.daemonHost,
  });
  const stopTargetHost =
    worktreeConfig && worktreeCleanupHost
      ? worktreeCleanupHost
      : boundHost ||
        worktreeCleanupHost ||
        normalizeHost(task.executionHost) ||
        normalizeHost(task.agentHost) ||
        normalizeHost(task.project?.daemonHost);

  if (worktreeConfig && !stopTargetHost) {
    return { ok: false, status: 409, error: "Task missing daemon binding" };
  }

  // 3. Best-effort stop (do not block on convergence).
  if (needsStop && stopTargetHost) {
    const requestId = randomUUID();
    const ackPromise = realtimeHub.waitForTaskStopAck(taskId, requestId, 2500);
    realtimeHub.bindTaskToAgent(taskId, stopTargetHost, userId);
    let delivered = false;
    try {
      ({ delivered } = await enqueueAndAttemptAgentCommand(
        {
          userId,
          agentHost: stopTargetHost,
          taskId,
          eventType: "stop_task",
          requestId,
          envelope: {
            type: "stop_task",
            payload: {
              task_id: taskId,
              project_id: task.projectId,
              request_id: requestId,
              reason,
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

  // 4. Worktree cleanup + schedule/runtime teardown + archive stamp. These
  //    writes share one transaction. If another active task initially blocks
  //    cleanup, a post-commit recheck closes the cross-task concurrency race:
  //    the last archive will observe no active sibling and enqueue cleanup.
  if (worktreeConfig) {
    let cleanupEnqueued = false;
    await db.$transaction(async (tx) => {
      await acquireTaskWorktreeMutationLock(tx as any, taskId);
      const sharedWorktreeTask =
        (
          await tx.task.findMany({
            where: {
              projectId: task.projectId,
              id: { not: taskId },
              achievedAt: null,
            },
            select: { id: true, launchConfig: true },
          })
        ).find((candidate) =>
          hasSameTaskWorktreeRoot(task.launchConfig, candidate.launchConfig),
        ) ?? null;
      if (!sharedWorktreeTask?.id || sharedWorktreeTask.id === taskId) {
        await tx.agentOutbox.create({
          data: buildTaskWorktreeCleanupOutboxData({
            userId,
            agentHost: stopTargetHost,
            taskId,
            projectId: task.projectId,
            launchConfig: task.launchConfig,
            requestId: randomUUID(),
            force: true,
          }),
        });
        cleanupEnqueued = true;
      }
      await deleteRuntimeRows(tx, taskId);
      await tx.task.update({
        where: { id: taskId },
        data: args.archivePatch,
      });
    });

    if (!cleanupEnqueued) {
      await db.$transaction(async (tx) => {
        await acquireTaskWorktreeMutationLock(tx as any, taskId);
        const activeSharedWorktreeTask =
          (
            await tx.task.findMany({
              where: {
                projectId: task.projectId,
                id: { not: taskId },
                achievedAt: null,
              },
              select: { id: true, launchConfig: true },
            })
          ).find((candidate) =>
            hasSameTaskWorktreeRoot(task.launchConfig, candidate.launchConfig),
          ) ?? null;
        if (!activeSharedWorktreeTask) {
          await tx.agentOutbox.create({
            data: buildTaskWorktreeCleanupOutboxData({
              userId,
              agentHost: stopTargetHost,
              taskId,
              projectId: task.projectId,
              launchConfig: task.launchConfig,
              requestId: randomUUID(),
              force: true,
            }),
          });
        }
      });
    }
  } else {
    await db.$transaction(async (tx) => {
      await deleteRuntimeRows(tx, taskId);
      await tx.task.update({
        where: { id: taskId },
        data: args.archivePatch,
      });
    });
  }

  // 5. Optional attachment dir removal + hub unbind.
  if (args.deleteAttachmentDirectory) {
    try {
      await deleteTaskAttachmentDirectory(taskId);
    } catch (error) {
      console.error(
        `[teardown] failed to delete attachment directory: taskId=${taskId}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  realtimeHub.unbindTask(taskId);

  return { ok: true };
}

/**
 * Cancel live schedules and delete runtime-only rows. Message and Task rows
 * remain; the caller stamps the Task as achieved in the same transaction.
 */
async function deleteRuntimeRows(
  client: Pick<typeof db, "ptySession" | "scheduledMessage" | "taskRuntimeState">,
  taskId: string,
): Promise<void> {
  await client.scheduledMessage.updateMany({
    where: { taskId, status: "active" },
    data: { status: "canceled", updatedAt: new Date() },
  });
  try {
    await client.ptySession.deleteMany({ where: { taskId } });
  } catch (error) {
    if (!isMissingPtySchemaError(error)) throw error;
  }
  try {
    await client.taskRuntimeState.deleteMany({ where: { taskId } });
  } catch (error) {
    // TaskRuntimeState may be absent on stale schemas; treat as clean.
    if (!isMissingPtySchemaError(error)) {
      console.error(
        `[teardown] failed to delete runtime state: taskId=${taskId}, error=${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

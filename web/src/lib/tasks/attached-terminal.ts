import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { deleteTaskAttachmentDirectory } from "@/lib/tasks/task-file-storage";
import { isMissingPtySchemaError } from "@/lib/tasks/pty-compat";
import {
  buildPtySessionCreateSeed,
  dispatchPtyTaskCreation,
  resolvePtyAgentHost,
  type ConnectedAgent,
} from "@/lib/tasks/pty-runtime";
import { resolveTaskWorktreeCwdFromLaunchConfig } from "@/lib/tasks/worktree";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  parseJsonObject,
  serializeJsonObject,
  type JsonObject,
} from "@/lib/tasks/task-config";

/**
 * Lookup the AttachedTerminal row binding `aiTaskId` to its PTY task.
 * Returns null when there is no attached terminal or when the schema
 * predates this feature (the catch in withAttachedTerminalSchemaFallback
 * keeps GET /api/tasks healthy on stale databases).
 */
export const findAttachedTerminalForAiTask = async (aiTaskId: string) => {
  try {
    return await db.attachedTerminal.findUnique({
      where: { aiTaskId },
    });
  } catch (error) {
    if (isMissingAttachedTerminalSchemaError(error)) return null;
    throw error;
  }
};

/**
 * Returns the set of PTY task ids that are attached to some AI task in
 * `projectIds`. The caller filters these out of the top-level task list so
 * the attached terminal doesn't appear as a standalone PTY card.
 *
 * Returns an empty set on schema-missing errors so the list endpoint stays
 * up during rolling deployment.
 */
export const findAttachedPtyTaskIdsByProjects = async (
  userId: string,
  projectIds: string[] | null,
): Promise<Set<string>> => {
  try {
    const rows = await db.attachedTerminal.findMany({
      where: {
        aiTask: {
          project: { userId },
          ...(projectIds && projectIds.length > 0
            ? projectIds.length === 1
              ? { projectId: projectIds[0] }
              : { projectId: { in: projectIds } }
            : {}),
        },
      },
      select: { ptyTaskId: true },
    });
    return new Set(rows.map((r) => r.ptyTaskId));
  } catch (error) {
    if (isMissingAttachedTerminalSchemaError(error)) return new Set();
    throw error;
  }
};

export type AttachedTerminalSummary = {
  id: string;
  ptyTaskId: string;
  ptyTaskStatus: string | null;
};

/**
 * Returns a map of aiTaskId -> AttachedTerminalSummary for every AI task in
 * `aiTaskIds` that has an attached terminal. Used to enrich GET /api/tasks
 * responses so the UI can render the PTY toggle button (including the
 * alive/dead colour) without a second fetch.
 */
export const findAttachedTerminalsByAiTaskIds = async (
  aiTaskIds: string[],
): Promise<Map<string, AttachedTerminalSummary>> => {
  if (aiTaskIds.length === 0) return new Map();
  try {
    const rows = await db.attachedTerminal.findMany({
      where: { aiTaskId: { in: aiTaskIds } },
      select: {
        id: true,
        aiTaskId: true,
        ptyTaskId: true,
        ptyTask: { select: { status: true } },
      },
    });
    return new Map(
      rows.map((r) => [
        r.aiTaskId,
        {
          id: r.id,
          ptyTaskId: r.ptyTaskId,
          ptyTaskStatus: r.ptyTask?.status ?? null,
        },
      ]),
    );
  } catch (error) {
    if (isMissingAttachedTerminalSchemaError(error)) return new Map();
    throw error;
  }
};

/**
 * Loads a single AttachedTerminalSummary for an AI task, denormalising the
 * PTY task's status in one query. Used by the single-task GET endpoint.
 */
export const loadAttachedTerminalSummary = async (
  aiTaskId: string,
): Promise<AttachedTerminalSummary | null> => {
  try {
    const row = await db.attachedTerminal.findUnique({
      where: { aiTaskId },
      select: {
        id: true,
        ptyTaskId: true,
        ptyTask: { select: { status: true } },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      ptyTaskId: row.ptyTaskId,
      ptyTaskStatus: row.ptyTask?.status ?? null,
    };
  } catch (error) {
    if (isMissingAttachedTerminalSchemaError(error)) return null;
    throw error;
  }
};

/**
 * Best-effort kill + delete a PTY task. Caller has already authenticated the
 * user and verified ownership. Mirrors the non-worktree branch of
 * DELETE /api/tasks/[taskId] so that attached-terminal deletes — and the
 * AI-task-delete pre-hook — get the same agent-kill + DB-cleanup behavior.
 */
export const deletePtyTaskWithKill = async (args: {
  userId: string;
  ptyTaskId: string;
  /**
   * Set by callers that suspect the agent may have already spawned the
   * process even though our DB still shows status="init" (e.g. the rollback
   * path in POST /api/tasks/[aiTaskId]/terminal when `dispatch...` threw
   * after the bind). Forces a stop_task even on an `init` row so an orphan
   * agent process can't outlive the cleanup.
   */
  forceStop?: boolean;
}): Promise<void> => {
  const { userId, ptyTaskId, forceStop = false } = args;
  const ptyTask = await db.task.findFirst({
    where: { id: ptyTaskId, project: { userId } },
    select: {
      id: true,
      projectId: true,
      taskType: true,
      agentHost: true,
      executionHost: true,
      status: true,
      project: { select: { daemonHost: true } },
    },
  });
  if (!ptyTask) return;

  const normalizedStatus = normalizeTaskStatus(ptyTask.status);
  // A task already in `killing` state has a stop_task in flight; re-sending
  // would issue a second stop_task with a fresh requestId, and our 2.5s
  // ackPromise may resolve for whichever requestId the daemon happens to
  // ack first — masking a stale kill. Skip the dispatch in that case and
  // let the in-flight kill drive cleanup.
  //
  // `forceStop` overrides for the rollback path: an `init` row may still
  // correspond to a spawned process on the agent if the create envelope
  // was partially received before dispatch threw.
  const needsStop =
    normalizedStatus === "running" ||
    normalizedStatus === "unknown" ||
    (forceStop && normalizedStatus !== "killing");
  const boundHost = normalizeOptionalString(realtimeHub.getTaskAgentHost(ptyTaskId));
  const stopTargetHost =
    boundHost ||
    normalizeOptionalString(ptyTask.executionHost) ||
    normalizeOptionalString(ptyTask.agentHost) ||
    normalizeOptionalString(ptyTask.project?.daemonHost);

  if (needsStop && stopTargetHost) {
    const requestId = randomUUID();
    const ackPromise = realtimeHub.waitForTaskStopAck(ptyTaskId, requestId, 2500);
    realtimeHub.bindTaskToAgent(ptyTaskId, stopTargetHost);
    let delivered = false;
    try {
      ({ delivered } = await enqueueAndAttemptAgentCommand(
        {
          userId,
          agentHost: stopTargetHost,
          taskId: ptyTaskId,
          eventType: "stop_task",
          requestId,
          envelope: {
            type: "stop_task",
            payload: {
              task_id: ptyTaskId,
              project_id: ptyTask.projectId,
              request_id: requestId,
              reason: "attached_terminal_deleted_by_user",
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
      realtimeHub.cancelTaskStopAck(ptyTaskId, requestId);
    }
  }

  // Atomicity: the three DB deletes (messages → ptySession → task) must
  // succeed or fail together. If the legacy schema lacks the PtySession
  // table, the array form would surface that as a generic Prisma error;
  // we detect that case beforehand by doing the messages delete first
  // outside the transaction (it doesn't have a legacy-schema concern), and
  // gating the ptySession+task pair inside the transaction.
  //
  // The previous implementation deleted in three separate awaits, leaving a
  // half-cleaned row possible if step 2 or 3 transiently failed. That
  // failure mode is the primary failure mode for the rollback path called
  // from POST /api/tasks/[aiTaskId]/terminal — fixing it here.
  await db.message.deleteMany({ where: { taskId: ptyTaskId } });
  try {
    await db.$transaction([
      db.ptySession.deleteMany({ where: { taskId: ptyTaskId } }),
      db.task.delete({ where: { id: ptyTaskId } }),
    ]);
  } catch (error) {
    if (isMissingPtySchemaError(error)) {
      // Legacy schema without ptySession table — just delete the task row.
      // P2025 (record not found) is also tolerated: the row may have been
      // removed by a concurrent path (e.g., the AI task DELETE pre-hook).
      try {
        await db.task.delete({ where: { id: ptyTaskId } });
      } catch (inner) {
        if ((inner as { code?: unknown })?.code !== "P2025") throw inner;
      }
    } else if ((error as { code?: unknown })?.code === "P2025") {
      // Concurrent deletion — treat as already-clean.
    } else {
      throw error;
    }
  }
  // Side effects AFTER the DB transaction commits, so a failure above
  // leaves no observable change for app-gateway viewers.
  try {
    await deleteTaskAttachmentDirectory(ptyTaskId);
  } catch (error) {
    console.error(
      `[attached-terminal] failed to delete attachment dir: taskId=${ptyTaskId}, error=${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  realtimeHub.broadcast(userId, ptyTask.projectId, {
    type: "task_deleted",
    payload: { task_id: ptyTaskId, project_id: ptyTask.projectId },
  });
  realtimeHub.unbindTask(ptyTaskId);
};

/**
 * Atomically create the PTY Task row + PtySession row + AttachedTerminal
 * relationship row. The PTY task inherits projectId from the AI task, and a
 * launchConfig that defaults its cwd to the AI task's workspace.
 *
 * Throws on unique-constraint violation if a terminal is already attached to
 * the AI task; the caller maps that to a 409.
 */
export const createAttachedTerminalRecord = async (args: {
  aiTask: {
    id: string;
    projectId: string;
    title: string;
    launchConfig: unknown;
  };
  ptyTaskId?: string;
  ptyTaskTitle: string;
  agentHost: string | null;
  ptyLaunchConfig: JsonObject | null;
  status: string;
}) => {
  // Stamp the PTY task's own metadata with the owning AI task id so the
  // client can decide "this is an attached PTY, do not add it to the
  // top-level task list" from the PTY task object alone — without needing
  // the AI task to be loaded first. Closes a race where a WebSocket
  // task_status_update for the freshly-spawned PTY can fire before the
  // initial /api/tasks list fetch completes.
  const ptyMetadata: JsonObject = {
    attachedToAiTaskId: args.aiTask.id,
  };
  // Generate the PTY task id upfront so all three creates can run as an
  // array-batched transaction (single BEGIN/COMMIT, no JS-loop window
  // between statements). Interactive transactions held an open SQLite
  // write lock across the JS event loop, which under daemon read traffic
  // exceeded the default 5s timeout. The array form is also slightly
  // faster because Prisma pipelines the statements.
  const ptyTaskId = args.ptyTaskId ?? randomUUID();
  const ptySessionSeed = buildPtySessionCreateSeed(ptyTaskId, args.ptyLaunchConfig);
  const [ptyTask, ptySession, attached] = await db.$transaction([
    db.task.create({
      data: {
        id: ptyTaskId,
        projectId: args.aiTask.projectId,
        title: args.ptyTaskTitle,
        taskType: "pty_task",
        status: args.status,
        agentHost: args.agentHost,
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: serializeJsonObject(args.ptyLaunchConfig),
        metadata: JSON.stringify(ptyMetadata),
      },
    }),
    db.ptySession.create({
      data: ptySessionSeed,
    }),
    db.attachedTerminal.create({
      data: {
        aiTaskId: args.aiTask.id,
        ptyTaskId,
      },
    }),
  ]);
  return { ptyTask, ptySession, attached };
};

/**
 * Resolve the agent host for an attached terminal. We prefer the AI task's
 * own agentHost so the terminal lands in the same environment. If that host
 * is not currently online with the pty_task capability we fall back to
 * picking a PTY-capable agent — same algorithm as standalone PTY tasks.
 *
 * Conductor-fire hosts are skipped because the fire SDK does not advertise
 * the `pty_task` capability — fire is a short-lived per-task process that
 * tunnels SDK commands, not a long-running daemon. For an AI task bound to
 * a fire host we fall back to the project's owning daemon (which has the
 * same workspace path on disk in the typical local-daemon-plus-fire setup).
 *
 * Cross-host safety: when the only candidates we have are fire hosts (and
 * thus get filtered out), we explicitly REFUSE to fall back to "any
 * PTY-capable agent". A PTY-capable daemon on a *different machine* would
 * spawn the terminal in an unrelated workspace path, silently surprising
 * the user. In that case we surface a 409 telling them to start a daemon
 * on the host where the AI task is actually running.
 */
export const resolveAttachedTerminalAgentHost = (args: {
  userId: string;
  aiTaskAgentHost: string | null;
  projectDaemonHost: string | null;
  ptyLaunchConfig: JsonObject | null;
}):
  | { agentHost: string }
  | { error: string; status: number } => {
  const connectedAgents = realtimeHub.getAgentsForUser(args.userId) as ConnectedAgent[];
  const aiHostWasFire = isConductorFireHost(args.aiTaskAgentHost);
  const daemonHostWasFire = isConductorFireHost(args.projectDaemonHost);
  const candidateAiHost =
    args.aiTaskAgentHost && !aiHostWasFire ? args.aiTaskAgentHost : null;
  const candidateDaemonHost =
    args.projectDaemonHost && !daemonHostWasFire ? args.projectDaemonHost : null;
  const preferred = candidateAiHost ?? candidateDaemonHost ?? null;

  // If we filtered every candidate out *because* it was a fire host, that
  // means the project is fire-only (no real daemon ever bound to it).
  // `resolvePtyAgentHost` with `requestedAgentHost: null` would pick any
  // online PTY agent in the user's pool — almost certainly on a different
  // machine, so the terminal would land in a directory that has nothing
  // to do with the AI task. Reject loudly instead.
  if (!preferred && (aiHostWasFire || daemonHostWasFire)) {
    return {
      error:
        "No conductor daemon is running on the host where this task lives. " +
        "Start `conductor daemon` on that host, then try again.",
      status: 409,
    };
  }

  const result = resolvePtyAgentHost({
    connectedAgents,
    requestedAgentHost: preferred,
    requestedBackendType: null,
    launchConfig: args.ptyLaunchConfig,
  });
  if ("error" in result) {
    return { error: result.error, status: result.status };
  }
  return { agentHost: result.agentHost };
};

/**
 * Dispatch the PTY creation command to the agent (same envelope as standalone
 * PTY task creation; the daemon does not need to distinguish them).
 */
export const dispatchAttachedTerminalCreation = async (args: {
  userId: string;
  agentHost: string;
  ptyTask: { id: string; projectId: string; title: string };
  ptySessionId: string;
  launchConfig: JsonObject | null;
}) => {
  await dispatchPtyTaskCreation({
    userId: args.userId,
    agentHost: args.agentHost,
    task: args.ptyTask,
    ptySessionId: args.ptySessionId,
    launchConfig: args.launchConfig,
    bindTaskToAgent: (taskId, host) => realtimeHub.bindTaskToAgent(taskId, host),
    sendToAgentHost: ({ userId: targetUserId, agentHost: targetHost, envelope }) =>
      realtimeHub.sendToAgentHost(targetUserId, targetHost, envelope),
    resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
  });
};

const isMissingAttachedTerminalSchemaError = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  if (code !== "P2021") return false;
  const message = String((error as { message?: unknown })?.message ?? "").toLowerCase();
  return message.includes("attached_terminal") || message.includes("attachedterminal");
};

export const ATTACHED_TERMINAL_SCHEMA_UNAVAILABLE_MESSAGE =
  "Attached terminals are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.";

export { isMissingAttachedTerminalSchemaError };

/**
 * PTY-relevant launch_config keys that we forward from an AI task onto its
 * attached terminal. Keep this list deliberately narrow:
 *
 * - `env` / `shell` shape the PTY child process. If the AI task pinned a
 *   custom shell or extra env, the terminal should match so commands
 *   behave the same in both panels.
 *
 * Explicitly NOT inherited (any of these on the AI task is AI-runner
 * configuration, not terminal configuration):
 *
 * - `command` / `args` — the PTY must default to an interactive shell,
 *   never re-run the AI backend.
 * - `entrypoint_type` / `entrypointType` / `tool_preset` / `toolPreset` —
 *   pick a backend for the AI task, irrelevant to a shell.
 * - `cols` / `rows` — the terminal client supplies a real size on attach;
 *   inheriting an AI-side stale value would just be overwritten anyway.
 * - `backendType`, `initialContent`, `resumeSessionId`, `sessionFilePath`,
 *   worktree fields — AI-only state. Worktree is reflected via the
 *   resolved cwd below; the daemon does not understand worktree config
 *   for PTY tasks.
 */
const PTY_INHERITABLE_LAUNCH_CONFIG_KEYS = ["env", "shell"] as const;

/**
 * Build the PTY launch_config that should be inherited from the AI task it
 * is attaching to. The terminal must open in the *same* on-disk directory
 * the AI task is running in:
 *
 * 1. If the AI task uses a worktree, mirror the daemon's path math
 *    (`projectWorkspacePath/.conductor/worktrees/<branch>[/projectRelativePath]`).
 *    Without this the terminal would land in the project root and the user
 *    would see different files than the AI task is editing.
 * 2. Otherwise honour an explicit `launch_config.cwd` (set by the AI task
 *    create endpoint for ordinary, non-worktree projects).
 * 3. Fall back to the bound project's workspacePath.
 *
 * In addition we forward a small whitelist of PTY-shaping fields
 * (`PTY_INHERITABLE_LAUNCH_CONFIG_KEYS`). See the constant above for the
 * exact rationale per field.
 */
export const inheritPtyLaunchConfigFromAiTask = (
  aiTaskLaunchConfig: unknown,
  projectWorkspacePath: string | null,
): JsonObject | null => {
  const aiConfig = parseJsonObject(aiTaskLaunchConfig);
  const worktreeCwd = resolveTaskWorktreeCwdFromLaunchConfig(aiTaskLaunchConfig);
  const cwd =
    worktreeCwd ??
    normalizeOptionalString(aiConfig?.cwd) ??
    normalizeOptionalString(projectWorkspacePath);
  if (!cwd) return null;

  const inherited: JsonObject = { cwd };
  if (aiConfig) {
    for (const key of PTY_INHERITABLE_LAUNCH_CONFIG_KEYS) {
      const value = aiConfig[key];
      if (value === undefined || value === null) continue;
      inherited[key] = value as JsonObject[string];
    }
  }
  return inherited;
};

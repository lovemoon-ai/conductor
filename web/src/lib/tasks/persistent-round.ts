import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  appendUserMessageToTask,
  TaskIngressError,
} from "@/lib/channel/task-ingress-service";
import { finalizeAiTaskCreation } from "@/lib/tasks/create-ai-task";
import {
  broadcastPersistentTaskUpdate,
  buildPersistentRoundPrompt,
  buildPersistentRoundSummaryRequest,
  updateTaskMetadata,
  withPersistentState,
} from "@/lib/tasks/persistent-task";
import { normalizeBackendType } from "@/lib/tasks/pty-runtime";
import { buildRemoteWorktreeBootstrap } from "@/lib/tasks/remote-worktree";
import { evaluateRuntimeHealth } from "@/lib/tasks/runtime-preflight";
import {
  normalizeOptionalString,
  normalizeTaskStatus,
  parseJsonObject,
  type JsonObject,
} from "@/lib/tasks/task-config";
import { resolveTaskStopTargetHost, stopTaskBeforeRelaunch } from "@/lib/tasks/task-stop";
import {
  buildTaskWorktreeLaunchConfig,
  inheritTaskWorktreeLaunchConfig,
  parseRemoteWorktreeLaunchConfig,
} from "@/lib/tasks/worktree";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import { buildMessageResponse } from "@/shared/utils/message-attachments";
import {
  PERSISTENT_ROUND_END_KIND,
  PERSISTENT_ROUND_START_KIND,
  readPersistentTaskState,
  type PersistentTaskState,
} from "@/shared/utils/persistent-task";

export type PersistentRoundWorktreeMode = "inherit" | "new" | "none";

/** Daemons that release a still-running or still-exiting fire before starting a round on the same task id. */
export const PERSISTENT_ROUND_CAPABILITY = "persistent_round_v1";

type PersistentTaskRow = NonNullable<Awaited<ReturnType<typeof findPersistentTask>>>;

export type PersistentRoundResult =
  | { ok: true; task: PersistentTaskRow }
  | { ok: false; status: number; error: string; details?: Record<string, unknown> };

// `unknown` included: the fire may still be alive behind a lost connection.
const POSSIBLY_LIVE_TASK_STATUSES = new Set(["init", "running", "killing", "unknown"]);

class RoundChangedError extends Error {}

const findPersistentTask = (userId: string, taskId: string) =>
  db.task.findFirst({
    where: { id: taskId, project: { userId } },
    include: { project: true, ptySession: true },
  });

const fail = (status: number, error: string, details?: Record<string, unknown>): PersistentRoundResult => ({
  ok: false,
  status,
  error,
  ...(details ? { details } : {}),
});

const ROUND_CHANGED_MESSAGE = "This task has moved to another round; review it before starting a new one.";
const roundChanged = () =>
  fail(409, ROUND_CHANGED_MESSAGE, { error: "round_changed", message: ROUND_CHANGED_MESSAGE });

const loadPersistentTask = async (
  userId: string,
  taskId: string,
): Promise<{ task: PersistentTaskRow; state: PersistentTaskState } | PersistentRoundResult> => {
  const task = await findPersistentTask(userId, taskId);
  if (!task) return fail(404, "Not found");
  if ((task.taskType ?? "ai_task") !== "ai_task") return fail(409, "Only ai_task can be persistent");
  if (task.achievedAt) return fail(409, "Task archived");
  const state = readPersistentTaskState(parseJsonObject(task.metadata));
  if (!state?.enabled) return fail(409, "Task is not persistent");
  return { task, state };
};

const nonFireHost = (value: unknown): string | null => {
  const host = normalizeOptionalString(value);
  return host && !isConductorFireHost(host) ? host : null;
};

/**
 * Ends the current round. A running task is asked for the rolling summary
 * (captured by `capturePersistentRoundSummary`); the fire keeps running until
 * the next round starts, because late summary chunks for a `killed` task are
 * dropped.
 */
export async function endPersistentRound(input: {
  userId: string;
  taskId: string;
}): Promise<PersistentRoundResult> {
  const loaded = await loadPersistentTask(input.userId, input.taskId);
  if ("ok" in loaded) return loaded;
  const { task, state } = loaded;
  if (state.roundEndedAt) return { ok: true, task };

  let roundEndMessageId: string | null = null;
  if (normalizeTaskStatus(task.status) === "running") {
    try {
      const { message } = await appendUserMessageToTask({
        userId: input.userId,
        taskId: task.id,
        role: "user",
        content: buildPersistentRoundSummaryRequest(state.round),
        metadata: { kind: PERSISTENT_ROUND_END_KIND, round: state.round },
      });
      roundEndMessageId = message.id;
    } catch (error) {
      // No live fire: the round simply ends without an AI summary.
      if (!(error instanceof TaskIngressError && error.code === "TASK_MISSING_ACTIVE_FIRE_OWNER")) {
        throw error;
      }
    }
  }

  const written = await updateTaskMetadata(db.task, task.id, (metadata) =>
    withPersistentState(metadata, { roundEndedAt: new Date().toISOString(), roundEndMessageId }),
  );
  const updated = await findPersistentTask(input.userId, task.id);
  if (!written || !updated) return fail(404, "Not found");
  broadcastPersistentTaskUpdate({ userId: input.userId, taskId: task.id, ...written });
  return { ok: true, task: updated };
}

/**
 * Starts a new round: stops the previous fire, then dispatches `create_task`
 * for the SAME task id without a session, so the daemon starts a fresh AI
 * session whose first prompt carries only the standing instructions and the
 * previous rounds' summary.
 */
export async function startPersistentRound(input: {
  userId: string;
  taskId: string;
  content: string;
  backendType?: string | null;
  agentHost?: string | null;
  worktree?: PersistentRoundWorktreeMode;
  /** The round the caller saw; a mismatch means another client moved the task on. */
  expectedRound?: number;
}): Promise<PersistentRoundResult> {
  const content = input.content.trim();
  if (!content) return fail(400, "content is required");

  const loaded = await loadPersistentTask(input.userId, input.taskId);
  if ("ok" in loaded) return loaded;
  const { task, state } = loaded;
  if (input.expectedRound !== undefined && input.expectedRound !== state.round) return roundChanged();
  const project = task.project;
  const status = normalizeTaskStatus(task.status);

  const backendType = normalizeBackendType(input.backendType) ?? normalizeBackendType(task.backendType);
  if (!backendType) return fail(400, "backend_type is required");

  const projectDaemonHost = nonFireHost(project.daemonHost);
  const previousRunHost =
    nonFireHost(task.agentHost) ?? nonFireHost(parseJsonObject(task.metadata)?.daemonName);
  const agentHost = normalizeOptionalString(input.agentHost) ?? previousRunHost ?? projectDaemonHost;
  if (!agentHost) return fail(409, "No daemon selected for the new round");
  if (isConductorFireHost(agentHost)) return fail(409, "A new round must run on a daemon");
  const agent = realtimeHub.getAgentsForUser(input.userId).find((item) => item.host === agentHost);
  if (!agent) return fail(409, `Daemon ${agentHost} is offline`);
  if (!agent.supportedBackends.includes(backendType)) {
    return fail(409, `Daemon ${agentHost} does not support backend ${backendType}`);
  }
  // The previous round's fire can outlive its "stopped" status on that daemon
  // (still exiting, or a tmux session the reaper has not swept); an old daemon
  // would silently drop the new round as a duplicate and leave it in `init`.
  if (agentHost === previousRunHost && !agent.capabilities.includes(PERSISTENT_ROUND_CAPABILITY)) {
    return fail(409, `Upgrade the conductor CLI on ${agentHost} to start rounds on it`);
  }
  const runtimeProblem = evaluateRuntimeHealth({ agent, backend: backendType });
  if (runtimeProblem) {
    return fail(503, runtimeProblem.message, {
      error: "runtime_unavailable",
      backend: runtimeProblem.backend,
      daemon_host: runtimeProblem.daemonHost,
      reason: runtimeProblem.reason,
      message: runtimeProblem.message,
      recovery: runtimeProblem.recovery,
    });
  }

  const projectWorkspacePath = normalizeOptionalString(project.workspacePath);
  const projectRepoRoot = normalizeOptionalString(project.repoRoot);
  const projectWorktreeBranch = normalizeOptionalString(project.worktreeBranch);
  const onProjectDaemon = Boolean(projectDaemonHost) && agentHost === projectDaemonHost;
  const projectCwdLaunchConfig: JsonObject =
    onProjectDaemon && projectWorkspacePath
      ? {
          cwd: projectWorkspacePath,
          ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
        }
      : {};
  const previousLaunchConfig = parseJsonObject(task.launchConfig);
  let launchConfig: JsonObject;
  const worktreeMode = input.worktree ?? "inherit";
  if (worktreeMode === "new") {
    if (!onProjectDaemon || !projectWorkspacePath || !projectRepoRoot) {
      return fail(409, "A new worktree requires the git-backed project daemon");
    }
    launchConfig = buildTaskWorktreeLaunchConfig({
      launchConfig: null,
      worktreeId: task.id,
      projectRepoRoot,
      projectWorkspacePath,
      projectWorktreeBranch,
      projectLastCommit: project.lastCommit,
    });
  } else if (worktreeMode === "none") {
    launchConfig = projectCwdLaunchConfig;
  } else if (agentHost === previousRunHost) {
    const previousCwd = normalizeOptionalString(previousLaunchConfig?.cwd);
    launchConfig =
      inheritTaskWorktreeLaunchConfig(previousLaunchConfig) ??
      (previousCwd
        ? { ...projectCwdLaunchConfig, cwd: previousCwd }
        : projectCwdLaunchConfig);
  } else {
    // Local paths only exist on the machine that ran the previous round.
    const remoteWorktree = parseRemoteWorktreeLaunchConfig(previousLaunchConfig);
    launchConfig = remoteWorktree ? { remoteWorktree } : projectCwdLaunchConfig;
  }

  if (POSSIBLY_LIVE_TASK_STATUSES.has(status)) {
    const stopTargetHost = resolveTaskStopTargetHost({
      taskId: task.id,
      executionHost: task.executionHost,
      agentHost: task.agentHost,
    });
    if (stopTargetHost) {
      const stopped = await stopTaskBeforeRelaunch({
        userId: input.userId,
        taskId: task.id,
        projectId: task.projectId,
        stopTargetHost,
        reason: "persistent_new_round",
      });
      if (!stopped.ok) {
        return fail(409, stopped.error ?? "Failed to stop the current round");
      }
    }
  }

  const round = state.round + 1;
  const dividerContent = `Round ${round} · ${backendType} on ${agentHost}`;
  const dividerMetadata = {
    synthetic: true,
    kind: PERSISTENT_ROUND_START_KIND,
    round,
    backend_type: backendType,
    agent_host: agentHost,
  };
  // Explicit timestamps keep the divider strictly before the first message.
  const dividerAt = new Date();
  const messageAt = new Date(dividerAt.getTime() + 1);
  let transaction;
  try {
    transaction = await db.$transaction(async (tx) => {
      // Re-read after the stop: the summary may have landed meanwhile. The
      // compare-and-swap on the raw metadata makes a concurrent round start
      // (double submit, another device) fail instead of creating two rounds.
      const current = await tx.task.findUnique({ where: { id: task.id }, select: { metadata: true } });
      const currentMetadata = parseJsonObject(current?.metadata);
      const currentState = readPersistentTaskState(currentMetadata);
      if (!currentState?.enabled || currentState.round !== state.round) {
        throw new RoundChangedError();
      }
      const metadata = withPersistentState(currentMetadata, {
        round,
        roundEndedAt: null,
        roundEndMessageId: null,
      });
      const { count } = await tx.task.updateMany({
        where: { id: task.id, metadata: current?.metadata ?? null },
        data: {
          status: "init",
          agentHost,
          executionHost: agentHost,
          backendType,
          sessionId: null,
          sessionFilePath: null,
          killedReason: null,
          killedAt: null,
          launchConfig: Object.keys(launchConfig).length > 0 ? JSON.stringify(launchConfig) : null,
          metadata: JSON.stringify(metadata),
        },
      });
      if (count !== 1) {
        throw new RoundChangedError();
      }
      // Commands still queued for the previous round (a stop_task or summary
      // request for a fire that went offline) would otherwise reach the new
      // round's fire, which reconnects under the same host name.
      await tx.agentOutbox.updateMany({
        where: { taskId: task.id, status: { in: ["pending", "sent"] } },
        data: { status: "failed", lastError: "superseded_by_persistent_round" },
      });
      // The previous session's runtime status (e.g. a reply cut off by the stop)
      // must not leak into the new round.
      await tx.taskRuntimeState.deleteMany({ where: { taskId: task.id } });
      const divider = await tx.message.create({
        data: {
          taskId: task.id,
          role: "sdk",
          content: dividerContent,
          metadata: JSON.stringify(dividerMetadata),
          createdAt: dividerAt,
        },
        select: { id: true, createdAt: true },
      });
      const userMessage = await tx.message.create({
        data: { taskId: task.id, role: "user", content, createdAt: messageAt },
        select: { id: true, createdAt: true },
      });
      const updated = await tx.task.findUnique({
        where: { id: task.id },
        include: { project: true, ptySession: true },
      });
      return { divider, userMessage, updated: updated!, state: currentState, metadata };
    });
  } catch (error) {
    if (error instanceof RoundChangedError) return roundChanged();
    throw error;
  }
  const { divider, userMessage, updated, metadata } = transaction;

  realtimeHub.broadcast(input.userId, task.projectId, {
    type: "task_sdk_message",
    payload: {
      ...buildMessageResponse({
        id: divider.id,
        taskId: task.id,
        role: "sdk",
        content: dividerContent,
        metadata: dividerMetadata,
        createdAt: divider.createdAt,
      }),
      task_id: task.id,
      project_id: task.projectId,
    },
  });
  broadcastPersistentTaskUpdate({
    userId: input.userId,
    taskId: task.id,
    projectId: task.projectId,
    status: "init",
    metadata,
  });

  const roundPrompt = buildPersistentRoundPrompt({
    round,
    instructions: transaction.state.instructions,
    summary: transaction.state.summary,
    content,
  });
  const remoteWorktree = parseRemoteWorktreeLaunchConfig(launchConfig);
  await finalizeAiTaskCreation({
    userId: input.userId,
    projectId: task.projectId,
    title: task.title,
    agentHost,
    task: updated,
    initialMessage: userMessage,
    initialMessageContent: content,
    effectiveLaunchConfig: launchConfig,
    replaceExistingFire: true,
    agentInitialContent: remoteWorktree
      ? buildRemoteWorktreeBootstrap({
          remoteWorktree,
          localWorkspacePath: projectWorkspacePath,
          taskPrompt: roundPrompt,
        })
      : roundPrompt,
  });

  return { ok: true, task: updated };
}

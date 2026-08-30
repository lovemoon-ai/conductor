import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import { enqueueAndAttemptAgentCommand } from "@/lib/realtime/agent-outbox";
import { realtimeHub, type TaskWorktreeCleanupResult } from "@/lib/realtime/hub";
import {
  normalizeOptionalString,
  parseJsonObject,
  type JsonObject,
} from "./task-config";

type TaskWorktreeLaunchConfig = {
  worktree: true;
  worktreeId: string;
  worktreeBranch: string;
  worktreeBaseRef: string;
  projectRepoRoot: string;
  projectWorkspacePath: string;
  projectRelativePath: string;
  /**
   * A reuse-only member shares an existing worktree but must never create it.
   * The daemon waits for the owner's `git worktree add` instead of racing it
   * on the same branch. Carrying the *full* worktree identity (rather than a
   * bare `cwd`) is what keeps `hasSameTaskWorktreeRoot` able to see this task
   * as a sibling, so teardown will not delete the directory out from under it.
   */
  worktreeReuseOnly?: true;
};

const TASK_WORKTREE_CLEANUP_TIMEOUT_MS = 15_000;

const isWindowsStylePath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(value) || value.includes("\\");

const selectPathApi = (...values: string[]) =>
  values.some((value) => isWindowsStylePath(value)) ? path.win32 : path.posix;

const normalizeBoolean = (value: unknown): boolean => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 1;
  }
  if (typeof value !== "string") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const omitWorktreeFields = (launchConfig: JsonObject | null): JsonObject => {
  const next = { ...(launchConfig ?? {}) };
  delete next.createWorktree;
  delete next.create_worktree;
  delete next.cwd;
  delete next.worktreeId;
  delete next.worktree_id;
  delete next.worktreeBranch;
  delete next.worktree_branch;
  delete next.worktreeBaseRef;
  delete next.worktree_base_ref;
  delete next.projectRepoRoot;
  delete next.project_repo_root;
  delete next.projectWorkspacePath;
  delete next.project_workspace_path;
  delete next.projectRelativePath;
  delete next.project_relative_path;
  delete next.worktreeReuseOnly;
  delete next.worktree_reuse_only;
  return next;
};

const computeProjectRelativePath = (
  projectRepoRoot: string,
  projectWorkspacePath: string,
): string => {
  const pathApi = selectPathApi(projectRepoRoot, projectWorkspacePath);
  const relativePath = pathApi.relative(projectRepoRoot, projectWorkspacePath);
  if (!relativePath || relativePath === ".") {
    return ".";
  }
  if (relativePath.startsWith("..") || pathApi.isAbsolute(relativePath)) {
    throw new Error("Project workspace must stay within the git repository root");
  }
  return relativePath;
};

export const isTaskWorktreeRequested = (launchConfig: JsonObject | null): boolean =>
  normalizeBoolean(
    launchConfig?.worktree ??
      launchConfig?.createWorktree ??
      launchConfig?.create_worktree,
  );

const buildInitialWorktreeBranchName = (): string =>
  randomBytes(3).toString("hex");

// Mirrors cli/src/daemon.js buildTaskWorktreeRoot — keep in sync.
// Identity must key off the on-disk folder name, not the raw branch, so that
// two branches that sanitize to the same path are treated as one worktree.
const sanitizeWorktreeFolderName = (branch: string): string =>
  branch.replace(/[/\\]/g, "_").replace(/\.\./g, "_");

export const hasSameTaskWorktreeRoot = (
  referenceLaunchConfig: unknown,
  candidateLaunchConfig: unknown,
): boolean => {
  const reference = parseTaskWorktreeLaunchConfig(referenceLaunchConfig);
  const candidate = parseTaskWorktreeLaunchConfig(candidateLaunchConfig);
  if (!reference || !candidate) {
    return false;
  }

  return (
    sanitizeWorktreeFolderName(reference.worktreeBranch) ===
      sanitizeWorktreeFolderName(candidate.worktreeBranch) &&
    reference.projectWorkspacePath === candidate.projectWorkspacePath
  );
};

export const getTaskWorktreeRootKey = (launchConfig: unknown): string | null => {
  const parsed = parseTaskWorktreeLaunchConfig(launchConfig);
  if (!parsed) {
    return null;
  }

  return `${sanitizeWorktreeFolderName(parsed.worktreeBranch)}\u0000${parsed.projectWorkspacePath}`;
};

/**
 * Resolve the actual on-disk working directory for an AI task whose
 * launch_config describes a worktree. Mirrors the daemon-side path math in
 * `cli/src/daemon.js` (`buildTaskWorktreeRoot` + `resolveTaskWorktreeCwd`) so
 * that an attached PTY can land in the *same* directory the AI task is
 * running in.
 *
 * Cross-platform contract: the daemon's `buildTaskWorktreeRoot` uses Node's
 * runtime-default `path` module (POSIX on macOS/Linux, win32 on Windows).
 * The daemon itself is the source of truth for which separator is correct.
 * We approximate it with `selectPathApi`, which inspects the string shape of
 * the inputs (`isWindowsStylePath`) — that is faithful for any path the
 * daemon previously stored in its native style, which is the only way these
 * launch_config fields are populated today. If a future feature ever stores
 * a POSIX-shaped string from a Windows daemon (or vice versa), this helper
 * and the daemon will diverge — keep them in sync, or have the daemon round
 * trip its `process.platform` choice through launch_config.
 *
 * Returns null when the launch_config does not describe a worktree (the
 * caller falls back to `launch_config.cwd` / projectWorkspacePath in that
 * case).
 */
export const resolveTaskWorktreeCwdFromLaunchConfig = (
  launchConfig: unknown,
): string | null => {
  const parsed = parseTaskWorktreeLaunchConfig(launchConfig);
  if (!parsed) {
    return null;
  }
  const pathApi = selectPathApi(parsed.projectWorkspacePath, parsed.projectRelativePath);
  const folder = sanitizeWorktreeFolderName(parsed.worktreeBranch);
  const worktreeRoot = pathApi.join(
    parsed.projectWorkspacePath,
    ".conductor",
    "worktrees",
    folder,
  );
  if (!parsed.projectRelativePath || parsed.projectRelativePath === ".") {
    return worktreeRoot;
  }
  return pathApi.join(worktreeRoot, parsed.projectRelativePath);
};

export const resolveTaskWorktreeCleanupHost = (args: {
  boundHost?: unknown;
  agentHost?: unknown;
  executionHost?: unknown;
  metadata?: unknown;
  projectDaemonHost?: unknown;
}): string | null => {
  const boundHost = normalizeOptionalString(args.boundHost);
  const metadata = parseJsonObject(args.metadata);
  const metadataDaemonHost = normalizeOptionalString(metadata?.daemonName);
  const executionHost = normalizeOptionalString(args.executionHost);
  const agentHost = normalizeOptionalString(args.agentHost);
  const projectDaemonHost = normalizeOptionalString(args.projectDaemonHost);

  if (boundHost && !isConductorFireHost(boundHost)) {
    return boundHost;
  }
  if (
    isConductorFireHost(boundHost) ||
    isConductorFireHost(agentHost) ||
    isConductorFireHost(executionHost) ||
    isConductorFireHost(projectDaemonHost)
  ) {
    return metadataDaemonHost ?? projectDaemonHost ?? executionHost ?? agentHost ?? boundHost;
  }

  return executionHost ?? metadataDaemonHost ?? agentHost ?? projectDaemonHost ?? boundHost;
};

export const acquireTaskWorktreeMutationLock = async (
  tx: {
    task: {
      update: (args: {
        where: { id: string };
        data: { updatedAt: Date };
      }) => Promise<unknown>;
    };
  },
  taskId: string,
): Promise<void> => {
  // Force a row-level write lock by bumping updatedAt within the transaction.
  await tx.task.update({
    where: { id: taskId },
    data: { updatedAt: new Date() },
  });
};

const buildTaskStopOutboxData = (args: {
  userId: string;
  agentHost: string;
  taskId: string;
  projectId: string;
  requestId: string;
  reason: string;
}) => ({
  userId: args.userId,
  agentHost: args.agentHost,
  taskId: args.taskId,
  eventType: "stop_task",
  requestId: args.requestId,
  payloadJson: JSON.stringify({
    type: "stop_task",
    payload: {
      task_id: args.taskId,
      project_id: args.projectId,
      request_id: args.requestId,
      reason: args.reason,
    },
  }),
  status: "pending",
  attemptCount: 0,
  nextRetryAt: null,
});

export const buildTaskWorktreeCleanupOutboxData = (args: {
  userId: string;
  agentHost: string;
  taskId: string;
  projectId: string;
  launchConfig: unknown;
  requestId: string;
  force?: boolean;
}) => ({
  userId: args.userId,
  agentHost: args.agentHost,
  taskId: args.taskId,
  eventType: "cleanup_task_worktree",
  requestId: args.requestId,
  payloadJson: JSON.stringify({
    type: "cleanup_task_worktree",
    payload: {
      request_id: args.requestId,
      task_id: args.taskId,
      project_id: args.projectId,
      force: args.force === true,
      launch_config: parseJsonObject(args.launchConfig) ?? undefined,
    },
  }),
  status: "pending",
  attemptCount: 0,
  nextRetryAt: null,
});

export const requestTaskWorktreeCleanup = async (args: {
  userId: string;
  agentHost: string;
  taskId: string;
  projectId: string;
  launchConfig: unknown;
  force?: boolean;
  timeoutMs?: number;
}): Promise<
  | { ok: true; requestId: string; result: TaskWorktreeCleanupResult }
  | { ok: false; status: number; error: string }
> => {
  const requestId = randomUUID();
  const timeoutMs = args.timeoutMs ?? TASK_WORKTREE_CLEANUP_TIMEOUT_MS;
  const waitForCleanup = realtimeHub.waitForTaskWorktreeCleanup(requestId, timeoutMs);

  let delivered = false;
  try {
    ({ delivered } = await enqueueAndAttemptAgentCommand(
      {
        userId: args.userId,
        agentHost: args.agentHost,
        taskId: args.taskId,
        eventType: "cleanup_task_worktree",
        requestId,
        envelope: {
          type: "cleanup_task_worktree",
          payload: {
            request_id: requestId,
            task_id: args.taskId,
            project_id: args.projectId,
            force: args.force === true,
            launch_config: parseJsonObject(args.launchConfig) ?? undefined,
          },
        },
      },
      {
        agentHost: args.agentHost,
        sendToAgentHost: ({ userId, agentHost, envelope }) =>
          realtimeHub.sendToAgentHost(userId, agentHost, envelope),
        resolveTaskHost: (queuedTaskId) => realtimeHub.getTaskAgentHost(queuedTaskId),
      },
    ));
  } catch {
    realtimeHub.cancelTaskWorktreeCleanup(requestId);
    return {
      ok: false,
      status: 503,
      error: `Failed to send worktree cleanup to daemon ${args.agentHost}`,
    };
  }

  if (!delivered) {
    realtimeHub.cancelTaskWorktreeCleanup(requestId);
    return {
      ok: false,
      status: 503,
      error: `Failed to send worktree cleanup to daemon ${args.agentHost}`,
    };
  }

  const result = await waitForCleanup;
  if (!result) {
    realtimeHub.cancelTaskWorktreeCleanup(requestId);
    return {
      ok: false,
      status: 504,
      error: `Timed out waiting for daemon ${args.agentHost} to confirm worktree cleanup`,
    };
  }
  if (!result.cleaned || result.error) {
    return {
      ok: false,
      status: 409,
      error: result.error || "Failed to remove worktree",
    };
  }

  return { ok: true, requestId, result };
};

export const buildTaskWorktreeLaunchConfig = (args: {
  launchConfig: JsonObject | null;
  worktreeId: string;
  projectRepoRoot: string;
  projectWorkspacePath: string;
  projectWorktreeBranch?: string | null;
  projectLastCommit?: string | null;
}): JsonObject => {
  const worktreeId = normalizeOptionalString(args.worktreeId);
  const projectRepoRoot = normalizeOptionalString(args.projectRepoRoot);
  const projectWorkspacePath = normalizeOptionalString(args.projectWorkspacePath);
  if (!worktreeId || !projectRepoRoot || !projectWorkspacePath) {
    throw new Error("worktree launch config requires task id, repo root, and workspace path");
  }

  return {
    ...omitWorktreeFields(args.launchConfig),
    worktree: true,
    worktreeId,
    worktreeBranch: buildInitialWorktreeBranchName(),
    worktreeBaseRef:
      normalizeOptionalString(args.projectWorktreeBranch) ??
      normalizeOptionalString(args.projectLastCommit) ??
      "HEAD",
    projectRepoRoot,
    projectWorkspacePath,
    projectRelativePath: computeProjectRelativePath(projectRepoRoot, projectWorkspacePath),
  };
};

export const parseTaskWorktreeLaunchConfig = (
  launchConfig: unknown,
): TaskWorktreeLaunchConfig | null => {
  const normalizedLaunchConfig = parseJsonObject(launchConfig);
  if (!isTaskWorktreeRequested(normalizedLaunchConfig)) {
    return null;
  }

  const worktreeId =
    normalizeOptionalString(normalizedLaunchConfig?.worktreeId) ??
    normalizeOptionalString(normalizedLaunchConfig?.worktree_id);
  const worktreeBranch =
    normalizeOptionalString(normalizedLaunchConfig?.worktreeBranch) ??
    normalizeOptionalString(normalizedLaunchConfig?.worktree_branch);
  const projectRepoRoot =
    normalizeOptionalString(normalizedLaunchConfig?.projectRepoRoot) ??
    normalizeOptionalString(normalizedLaunchConfig?.project_repo_root);
  const projectWorkspacePath =
    normalizeOptionalString(normalizedLaunchConfig?.projectWorkspacePath) ??
    normalizeOptionalString(normalizedLaunchConfig?.project_workspace_path);
  const projectRelativePath =
    normalizeOptionalString(normalizedLaunchConfig?.projectRelativePath) ??
    normalizeOptionalString(normalizedLaunchConfig?.project_relative_path) ??
    ".";
  if (!worktreeId || !worktreeBranch || !projectRepoRoot || !projectWorkspacePath) {
    return null;
  }

  return {
    worktree: true,
    worktreeId,
    worktreeBranch,
    worktreeBaseRef:
      normalizeOptionalString(normalizedLaunchConfig?.worktreeBaseRef) ??
      normalizeOptionalString(normalizedLaunchConfig?.worktree_base_ref) ??
      "HEAD",
    projectRepoRoot,
    projectWorkspacePath,
    projectRelativePath,
    ...(normalizeBoolean(
      normalizedLaunchConfig?.worktreeReuseOnly ??
        normalizedLaunchConfig?.worktree_reuse_only,
    )
      ? { worktreeReuseOnly: true as const }
      : {}),
  };
};

export const inheritTaskWorktreeLaunchConfig = (
  launchConfig: unknown,
  options?: { reuseOnly?: boolean },
): JsonObject | null => {
  const parsed = parseTaskWorktreeLaunchConfig(launchConfig);
  if (!parsed) {
    return null;
  }

  return {
    worktree: true,
    worktreeId: parsed.worktreeId,
    worktreeBranch: parsed.worktreeBranch,
    worktreeBaseRef: parsed.worktreeBaseRef,
    projectRepoRoot: parsed.projectRepoRoot,
    projectWorkspacePath: parsed.projectWorkspacePath,
    projectRelativePath: parsed.projectRelativePath,
    // Sticky: a task that was reuse-only must stay reuse-only across restarts.
    // Dropping the flag here would silently promote a restarted reviewer back
    // into a worktree owner that runs `git worktree add -b`.
    ...(options?.reuseOnly || parsed.worktreeReuseOnly
      ? { worktreeReuseOnly: true }
      : {}),
  };
};

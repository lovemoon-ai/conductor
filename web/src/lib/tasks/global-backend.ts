/**
 * RFC 0041: run a task's AI on a "global backend" (a daemon × AI tool the user
 * enabled in settings) while its code stays on the project's own daemon.
 *
 * The task is filed on a project bound to the AI daemon (a mergeable copy of
 * the same repo if one exists, else the user's unbound default project) so the
 * `agentHost = project.daemonHost` invariant every router relies on holds. The
 * project the user started from becomes the display-only `secondProjectId`, and
 * the AI reaches that project over `conductor remote` — through a remote
 * worktree (RFC 0038) when a worktree was requested, else directly in the
 * project directory (`remoteWorkspace`).
 */

import type { Project } from "@prisma/client";
import { db } from "@/lib/db";
import { ensureDefaultProject } from "@/lib/auth/service";
import { canMergeProjectsByFields } from "@/lib/projects/grouping";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import { getGlobalAiBackends, type GlobalAiBackend } from "@/lib/user-preferences";
import { normalizeOptionalString, parseJsonObject, type JsonObject } from "./task-config";
import {
  buildRemoteWorktreeForTarget,
  checkRemoteDaemon,
  resolveRemoteTarget,
} from "./remote-worktree";
import {
  parseRemoteWorkspaceLaunchConfig,
  parseRemoteWorktreeLaunchConfig,
  parseTaskWorktreeLaunchConfig,
  type RemoteWorkspaceLaunchConfig,
  type RemoteWorktreeLaunchConfig,
} from "./worktree";

type ErrorResult = { error: string; status: number };

/**
 * Advertised by a daemon whose CLI can run a global-backend task's AI: drive
 * another daemon over `conductor remote` and bind the remote_* MCP tools to a
 * remoteWorkspace. An older CLI would start the task and then fail every step.
 */
export const GLOBAL_BACKEND_CAPABILITY = "global_backend_v1";

/** `global_backend` / `globalBackend` from a request body: absent, malformed, or a host + backend. */
export const readGlobalBackendRequest = (
  body: Record<string, unknown>,
): GlobalAiBackend | ErrorResult | null => {
  const raw = body.global_backend ?? body.globalBackend;
  if (raw == null || raw === false) return null;
  const record = parseJsonObject(raw);
  const host = normalizeOptionalString(record?.host);
  const backend = normalizeOptionalString(record?.backend)?.toLowerCase() ?? null;
  if (!host || !backend) {
    return { error: "global_backend requires host and backend", status: 400 };
  }
  return { host, backend };
};

/** Hosts a DaemonShare lends to this user: someone else's machine, never a global backend or target. */
export const findSharedGuestHosts = async (
  userId: string,
  hosts: string[],
): Promise<Set<string>> => {
  if (hosts.length === 0) return new Set();
  const shares = await db.daemonShare.findMany({
    where: { granteeUserId: userId, status: "active", guestHost: { in: hosts } },
    select: { guestHost: true },
  });
  return new Set(shares.flatMap((share) => (share.guestHost ? [share.guestHost] : [])));
};

export const describeGlobalBackend = (entry: GlobalAiBackend): string =>
  `${entry.backend} @ ${entry.host}`;

export type GlobalBackendMount = {
  /** The project the task is really filed under (bound to the AI daemon, or the default project). */
  mountProject: Project;
  /** The project the user started from; shown as the task's project. */
  secondProjectId: string;
  agentHost: string;
  backend: string;
  /** A's own clone of this repository (the AI's read-only cwd), if it has one. */
  localClonePath: string | null;
  remoteWorktree: RemoteWorktreeLaunchConfig | null;
  remoteWorkspace: RemoteWorkspaceLaunchConfig | null;
  metadata: JsonObject;
};

export const resolveGlobalBackendMount = async (args: {
  userId: string;
  tokenScope?: string | null;
  /** The project the user is creating the task in (its code lives on this project's daemon). */
  project: Pick<
    Project,
    "id" | "name" | "daemonHost" | "workspacePath" | "repoRoot" | "worktreeBranch" | "lastCommit" | "gitRemoteUrl" | "mergeOptOut"
  >;
  request: GlobalAiBackend;
  worktree: boolean;
  connectedAgents: Array<{ host: string; capabilities: string[] }>;
}): Promise<GlobalBackendMount | ErrorResult | { local: true }> => {
  const { project, request } = args;
  if (args.tokenScope === "daemon_share") {
    return { error: "global_backend is not available to a shared daemon token", status: 403 };
  }
  const enabled = await getGlobalAiBackends(args.userId);
  if (
    isConductorFireHost(request.host) ||
    !enabled.some((entry) => entry.host === request.host && entry.backend === request.backend)
  ) {
    return {
      error: `${describeGlobalBackend(request)} is not one of your global AI backends`,
      status: 409,
    };
  }
  const projectHost = normalizeOptionalString(project.daemonHost);
  if (!projectHost || !normalizeOptionalString(project.workspacePath)) {
    return {
      error: "global_backend requires a project bound to a daemon",
      status: 409,
    };
  }
  // Same machine: nothing is remote, it is an ordinary local task.
  if (projectHost === request.host) {
    return { local: true };
  }
  const aiAgent = args.connectedAgents.find((agent) => agent.host === request.host);
  if (!aiAgent) {
    return { error: `Daemon ${request.host} is offline`, status: 409 };
  }
  if (!aiAgent.capabilities.includes(GLOBAL_BACKEND_CAPABILITY)) {
    return {
      error: `Upgrade the conductor CLI on ${request.host} to use it as a global AI backend`,
      status: 409,
    };
  }
  const shared = await findSharedGuestHosts(args.userId, [request.host, projectHost]);
  if (shared.size > 0) {
    return {
      error: `global_backend only works between your own daemons; ${[...shared].join(", ")} is shared with you`,
      status: 403,
    };
  }
  const daemonError = checkRemoteDaemon(projectHost, args.connectedAgents);
  if (daemonError) return daemonError;
  // Only a worktree needs git; direct mode works in any project directory.
  const target = args.worktree ? resolveRemoteTarget(project) : null;
  if (target && "error" in target) return target;

  // Prefer the same repository bound on the AI daemon: the AI then starts in a
  // local clone, so CLAUDE.md / AGENTS.md / skills load natively.
  // Several same-name projects can live on one daemon; take the real copy.
  const candidates = await db.project.findMany({
    where: { userId: args.userId, daemonHost: request.host, name: project.name },
  });
  const sibling = candidates.find((candidate) => canMergeProjectsByFields(project, candidate)) ?? null;
  const hasSibling = Boolean(sibling);
  const mountProject = sibling ?? (await ensureDefaultProject(args.userId));
  // The default project can be bound to a daemon; filing the task there would
  // pin its AI to that daemon instead of the global backend.
  const mountHost = normalizeOptionalString(mountProject.daemonHost);
  if (mountHost && mountHost !== request.host) {
    return {
      error: `Your default project is bound to ${mountHost}, so it cannot hold a task whose AI runs on ${request.host}. Bind "${project.name}" on ${request.host} too, or unbind the default project.`,
      status: 409,
    };
  }

  const workspacePath = normalizeOptionalString(project.workspacePath)!;
  // A non-git directory is its own root: the remote_* tools are jailed to it.
  const remoteWorkspace: RemoteWorkspaceLaunchConfig = {
    host: projectHost,
    projectId: project.id,
    repoRoot: normalizeOptionalString(project.repoRoot) ?? workspacePath,
    workspacePath,
  };
  return {
    mountProject,
    secondProjectId: project.id,
    agentHost: request.host,
    backend: request.backend,
    localClonePath: hasSibling ? normalizeOptionalString(mountProject.workspacePath) : null,
    remoteWorktree: target ? buildRemoteWorktreeForTarget(target) : null,
    remoteWorkspace: target ? null : remoteWorkspace,
    metadata: { globalBackend: { host: request.host, backend: request.backend } },
  };
};

/** `metadata.globalBackend` of a task, if it was created on a global backend. */
export const readTaskGlobalBackend = (metadata: unknown): GlobalAiBackend | null => {
  const raw = parseJsonObject(parseJsonObject(metadata)?.globalBackend);
  const host = normalizeOptionalString(raw?.host);
  const backend = normalizeOptionalString(raw?.backend);
  return host && backend ? { host, backend } : null;
};

/**
 * A global-backend task whose AI runs on `agentHost` while its code is reached
 * over `conductor remote` (a remote worktree / workspace). Such a task may be
 * filed on a project bound to the code's daemon — "New task from this" on
 * another daemon keeps the source project — so `agentHost` legitimately
 * differs from `project.daemonHost` and must not be forced back onto it.
 */
export const isGlobalBackendAgentHost = (
  task: { metadata: unknown; launchConfig?: unknown },
  agentHost: string | null,
): boolean => {
  if (!agentHost || readTaskGlobalBackend(task.metadata)?.host !== agentHost) return false;
  return Boolean(
    parseRemoteWorktreeLaunchConfig(task.launchConfig) ?? parseRemoteWorkspaceLaunchConfig(task.launchConfig),
  );
};

const isWithinDir = (root: string, target: string): boolean => {
  const trimmed = root.replace(/[\\/]+$/, "");
  return target === trimmed || target.startsWith(`${trimmed}/`) || target.startsWith(`${trimmed}\\`);
};

/**
 * "New task from this" on another daemon: bind the successor to the source
 * task's directory on the source daemon, so its AI reaches the same files
 * through the remote_* tools. A source worktree becomes a `remoteWorktree` on
 * the same folder, so the successor co-owns it (teardown's sibling guard sees
 * both, and whichever task goes last cleans it up); anything else is direct
 * mode. `null` when that is not possible and the successor should start from
 * the target's own path as before.
 */
export const resolveCrossDaemonRemoteBinding = async (args: {
  userId: string;
  tokenScope?: string | null;
  sourceHost: string | null;
  /** The daemon the successor's AI runs on, and what it advertises. */
  targetHost: string;
  targetCapabilities: string[];
  connectedAgents: Array<{ host: string; capabilities: string[] }>;
  projectId: string;
  /** The source's local worktree launch_config, when it ran in one. */
  sourceWorktreeLaunchConfig: JsonObject | null;
  /** The source's working directory on `sourceHost`. */
  sourceCwd: string | null;
  /** The project's repository root, when the project is bound on `sourceHost`. */
  projectRepoRoot: string | null;
}): Promise<
  { remoteWorktree: RemoteWorktreeLaunchConfig } | { remoteWorkspace: RemoteWorkspaceLaunchConfig } | null
> => {
  const { sourceHost } = args;
  if (
    !sourceHost ||
    isConductorFireHost(sourceHost) ||
    args.tokenScope === "daemon_share" ||
    !args.targetCapabilities.includes(GLOBAL_BACKEND_CAPABILITY) ||
    checkRemoteDaemon(sourceHost, args.connectedAgents)
  ) {
    return null;
  }
  const worktree = args.sourceWorktreeLaunchConfig
    ? parseTaskWorktreeLaunchConfig(args.sourceWorktreeLaunchConfig)
    : null;
  let binding:
    | { remoteWorktree: RemoteWorktreeLaunchConfig }
    | { remoteWorkspace: RemoteWorkspaceLaunchConfig }
    | null = null;
  if (worktree) {
    // Same folder math as the daemon's local worktree:
    // <projectWorkspacePath>/.conductor/worktrees/<branch>.
    binding = {
      remoteWorktree: {
        host: sourceHost,
        projectId: args.projectId,
        repoRoot: worktree.projectRepoRoot,
        workspacePath: worktree.projectWorkspacePath,
        branch: worktree.worktreeBranch,
        baseRef: worktree.worktreeBaseRef,
      },
    };
  } else if (args.sourceCwd) {
    const workspacePath = args.sourceCwd;
    // The remote_* tools are jailed to repoRoot: the repository containing the
    // directory, or else the directory itself.
    const repoRoot =
      args.projectRepoRoot && isWithinDir(args.projectRepoRoot, workspacePath)
        ? args.projectRepoRoot
        : workspacePath;
    binding = { remoteWorkspace: { host: sourceHost, projectId: args.projectId, repoRoot, workspacePath } };
  }
  if (!binding) return null;
  // Only between the user's own daemons, like any global backend.
  const shared = await findSharedGuestHosts(args.userId, [sourceHost, args.targetHost]);
  return shared.size > 0 ? null : binding;
};

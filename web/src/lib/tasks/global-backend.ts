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
import type { RemoteWorkspaceLaunchConfig, RemoteWorktreeLaunchConfig } from "./worktree";

type ErrorResult = { error: string; status: number };

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
  project: Project;
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
  const shared = await findSharedGuestHosts(args.userId, [request.host, projectHost]);
  if (shared.size > 0) {
    return {
      error: `global_backend only works between your own daemons; ${[...shared].join(", ")} is shared with you`,
      status: 403,
    };
  }
  const daemonError = checkRemoteDaemon(projectHost, args.connectedAgents);
  if (daemonError) return daemonError;
  const target = resolveRemoteTarget(project);
  if ("error" in target) return target;

  // Prefer the same repository bound on the AI daemon: the AI then starts in a
  // local clone, so CLAUDE.md / AGENTS.md / skills load natively.
  const sibling = await db.project.findFirst({
    where: { userId: args.userId, daemonHost: request.host, name: project.name },
  });
  const hasSibling = Boolean(sibling && canMergeProjectsByFields(project, sibling));
  const mountProject = hasSibling ? sibling! : await ensureDefaultProject(args.userId);
  // The default project can be bound to a daemon; filing the task there would
  // pin its AI to that daemon instead of the global backend.
  const mountHost = normalizeOptionalString(mountProject.daemonHost);
  if (mountHost && mountHost !== request.host) {
    return {
      error: `Your default project is bound to ${mountHost}, so it cannot hold a task whose AI runs on ${request.host}. Bind "${project.name}" on ${request.host} too, or unbind the default project.`,
      status: 409,
    };
  }

  const remoteWorkspace: RemoteWorkspaceLaunchConfig = {
    host: target.host,
    projectId: target.projectId,
    repoRoot: target.repoRoot,
    workspacePath: target.workspacePath,
  };
  return {
    mountProject,
    secondProjectId: project.id,
    agentHost: request.host,
    backend: request.backend,
    localClonePath: hasSibling ? normalizeOptionalString(mountProject.workspacePath) : null,
    remoteWorktree: args.worktree ? buildRemoteWorktreeForTarget(target) : null,
    remoteWorkspace: args.worktree ? null : remoteWorkspace,
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

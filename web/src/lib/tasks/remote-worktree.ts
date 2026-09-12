/**
 * RFC 0038: a task whose AI runs on one daemon while its git worktree lives on
 * another. The launching side only needs three things from here: resolve the
 * remote target (which project row on which daemon, with what capabilities),
 * mint the `remoteWorktree` launch_config, and write the operating protocol the
 * AI follows to create and use that worktree over `conductor remote`.
 */

import { db } from "@/lib/db";
import { canMergeProjectsByFields } from "@/lib/projects/grouping";
import { normalizeOptionalString, parseJsonObject, type JsonObject } from "./task-config";
import {
  buildInitialWorktreeBranchName,
  resolveTaskWorktreeCwdFromLaunchConfig,
  toRemoteWorktreeCleanupLaunchConfig,
  type RemoteWorktreeLaunchConfig,
} from "./worktree";

/** Both are required: `exec` for git/build/test, `file` for `remote cp`. */
const REMOTE_WORKTREE_CAPABILITIES = ["remote_exec", "remote_file"] as const;
/** Mirrors fire's `parseGoalDirectiveFromMessage`: `/goal`, optionally with inline text. */
const GOAL_DIRECTIVE_LINE = /^\/goal(?:\s+.*)?$/i;

/** The only field a caller supplies; everything else is resolved server-side. */
export const readRemoteWorktreeRequestHost = (launchConfig: JsonObject | null): string | null => {
  const raw = parseJsonObject(launchConfig?.remoteWorktree ?? launchConfig?.remote_worktree);
  return normalizeOptionalString(raw?.host);
};

export const resolveRemoteWorktreeTarget = async (args: {
  userId: string;
  /** The project the task is filed under — the one bound on the launching daemon. */
  project: {
    id: string;
    name: string;
    daemonHost: string | null;
    workspacePath: string | null;
    gitRemoteUrl?: string | null;
    mergeOptOut?: boolean | null;
  };
  requestedHost: string;
  connectedAgents: Array<{ host: string; capabilities: string[] }>;
  /** `AuthUser.tokenScope`; a `daemon_share` token is pinned to one guest host. */
  tokenScope?: string | null;
}): Promise<{ remoteWorktree: RemoteWorktreeLaunchConfig } | { error: string; status: number }> => {
  const { project, requestedHost } = args;
  // The DaemonShare body scanner (`daemon-share/scope.ts`) keys on field names
  // like `agentHost`; `remoteWorktree.host` is a new host-targeting field, and a
  // share credential must never point a task at the grantee's other machines.
  if (args.tokenScope === "daemon_share") {
    return { error: "remoteWorktree is not available to a shared daemon token", status: 403 };
  }
  if (!project.daemonHost || !project.workspacePath) {
    return {
      error: "remoteWorktree requires a project bound on the launching daemon",
      status: 409,
    };
  }
  if (requestedHost === project.daemonHost) {
    return {
      error: `remoteWorktree.host must be a different daemon than ${project.daemonHost}; use worktree: true for a local worktree`,
      status: 409,
    };
  }
  const agent = args.connectedAgents.find((candidate) => candidate.host === requestedHost);
  if (!agent) {
    return { error: `Remote worktree daemon ${requestedHost} is offline`, status: 409 };
  }
  const missing = REMOTE_WORKTREE_CAPABILITIES.filter(
    (capability) => !agent.capabilities.includes(capability),
  );
  if (missing.length > 0) {
    return {
      error: `Daemon ${requestedHost} does not support ${missing.join(", ")}; upgrade it or enable the capability`,
      status: 409,
    };
  }

  // The same repository on the other daemon is its own Project row; the UI
  // shows the two as one merged card. Reuse the merge predicate so "same
  // project" means exactly what the user sees.
  const sibling = await db.project.findFirst({
    where: { userId: args.userId, daemonHost: requestedHost, name: project.name },
  });
  const siblingFields = sibling as
    | {
        id: string;
        name: string;
        daemonHost?: string | null;
        workspacePath?: string | null;
        repoRoot?: string | null;
        worktreeBranch?: string | null;
        lastCommit?: string | null;
        gitRemoteUrl?: string | null;
        mergeOptOut?: boolean | null;
      }
    | null;
  if (!siblingFields || !canMergeProjectsByFields(project, siblingFields)) {
    return {
      error: `Project "${project.name}" is not bound on daemon ${requestedHost}`,
      status: 409,
    };
  }
  const repoRoot = normalizeOptionalString(siblingFields.repoRoot);
  const workspacePath = normalizeOptionalString(siblingFields.workspacePath);
  if (!repoRoot || !workspacePath) {
    return {
      error: `Project "${project.name}" on daemon ${requestedHost} is not a git repository`,
      status: 409,
    };
  }

  return {
    remoteWorktree: {
      host: requestedHost,
      projectId: siblingFields.id,
      repoRoot,
      workspacePath,
      branch: buildInitialWorktreeBranchName(),
      baseRef:
        normalizeOptionalString(siblingFields.worktreeBranch) ??
        normalizeOptionalString(siblingFields.lastCommit) ??
        "HEAD",
    },
  };
};

/** On-disk locations the AI must use, derived with the same math the daemons use. */
export const resolveRemoteWorktreePaths = (remote: RemoteWorktreeLaunchConfig) => {
  const translated = toRemoteWorktreeCleanupLaunchConfig(remote);
  return {
    worktreeRoot: resolveTaskWorktreeCwdFromLaunchConfig({ ...translated, projectRelativePath: "." })!,
    workDir: resolveTaskWorktreeCwdFromLaunchConfig(translated)!,
  };
};

/**
 * The operating protocol, prepended to the user's first message (the one
 * channel both Claude Code and Codex read). Every rule here was hit in the
 * RFC 0038 experiment: stale base branch, tail-only output, `set -e`, the
 * in-flight cap, orphaned long commands, nested `conductor` losing its identity.
 */
export function buildRemoteWorktreeBootstrap(params: {
  remoteWorktree: RemoteWorktreeLaunchConfig;
  /** The read-only local clone the AI is started in, if any. */
  localWorkspacePath: string | null;
  taskPrompt?: string | null;
}): string {
  const { remoteWorktree: remote, localWorkspacePath, taskPrompt } = params;
  const { worktreeRoot, workDir } = resolveRemoteWorktreePaths(remote);
  const h = remote.host;
  const lines: string[] = [
    `[conductor:remote-worktree] Your workspace for this task is NOT on this machine. It lives on daemon "${h}":`,
    `  repo root:        ${remote.repoRoot}`,
    `  project dir:      ${remote.workspacePath}`,
    `  branch to create: ${remote.branch} (from ${remote.baseRef})`,
    `  worktree root:    ${worktreeRoot}`,
    `  work dir:         ${workDir}`,
  ];
  if (localWorkspacePath) {
    lines.push(
      `The directory you are running in (${localWorkspacePath}) is a READ-ONLY copy of the same repository on this machine. ` +
        `Grep and read it to orient yourself, but never edit files here, and never read a file locally once you have changed it remotely — the copies diverge.`,
    );
  }
  lines.push(
    "",
    "How to operate on the remote workspace",
    `- Run every file read/write, git, build and test command through: conductor remote exec -t ${h} -w <dir> -- <argv>`,
    `  Commands run without a shell. For pipes, redirects or multi-step scripts pass ONE script string: conductor remote exec -t ${h} -w <dir> -- bash -lc "$script"`,
    "  Start every script with `set -euo pipefail`; without it a failed middle step still exits 0.",
    "- Output keeps only the LAST 64 000 characters. Read files with `sed -n '1,200p' <file>` or `rg`, never a bare `cat` of a large file.",
    `- Copy files with: conductor remote cp <local> ${h}:<remote>   (or the reverse).`,
    `- Commands longer than 60 s: add --timeout 20m, or run them as \`nohup ... > log 2>&1 &\` and poll the log. If the CLI is interrupted it prints a run id; resume with: conductor remote wait -t ${h} <runId>`,
    "- Keep at most 6 remote commands in flight at once.",
    "- Never run `conductor` itself through remote exec (the remote strips CONDUCTOR_* variables). `conductor task`, `conductor issue` and `conductor send-file` run locally only.",
    "",
    "First steps, in this order, before any other work",
    `1. Sync the base branch, with -w ${remote.repoRoot}: git fetch --all --prune; then, if \`git branch --show-current\` prints "${remote.baseRef}" and \`git status --porcelain\` is empty: git merge --ff-only @{u}`,
    `2. Create the worktree, still with -w ${remote.repoRoot} (the worktree directory does not exist yet): git worktree add -b ${remote.branch} ${worktreeRoot} ${remote.baseRef}`,
    "   Use exactly this branch name and path — conductor removes the worktree by this path when the task is deleted.",
    `3. In ${remote.workspacePath}/.conductor/settings.yaml, for each entry under \`worktree.symlink\` whose source exists under ${remote.workspacePath} and is not tracked by git, create the same symlink under ${workDir}. If .gitmodules exists, run \`git submodule update --init --recursive\` in the worktree.`,
    `4. From now on use -w ${workDir} for every command. Read the repository's CLAUDE.md / AGENTS.md there first.`,
    "",
    `When you finish, commit your work on branch ${remote.branch} in the remote worktree. Do not remove the worktree; conductor cleans it up.`,
  );

  const bootstrap = lines.join("\n");
  const prompt = typeof taskPrompt === "string" ? taskPrompt.trim() : "";
  if (!prompt) {
    return bootstrap;
  }
  // Fire only honours `/goal` on the FIRST non-empty line of a message. Keep a
  // goal directive in front of the bootstrap or goal mode would silently drop.
  const promptLines = prompt.split("\n");
  const directive = promptLines[0].trim();
  if (GOAL_DIRECTIVE_LINE.test(directive)) {
    const rest = promptLines.slice(1).join("\n").trim();
    return `${directive}\n${bootstrap}${rest ? `\n\n--- Task ---\n${rest}` : ""}`;
  }
  return `${bootstrap}\n\n--- Task ---\n${prompt}`;
}

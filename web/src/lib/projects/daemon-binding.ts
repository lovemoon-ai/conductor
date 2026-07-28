import { randomUUID } from "crypto";
import { realtimeHub } from "@/lib/realtime/hub";
import {
  readProjectAgentsRegistry,
  type AgentRegistryEntry,
} from "@/lib/projects/project-settings-yaml";

const PROJECT_PATH_VALIDATION_TIMEOUT_MS = 5_000;
const PROJECT_PATH_VALIDATION_CAPABILITY = "project_path_validation";
const PROJECT_AGENTS_TIMEOUT_MS = 2_000;
const PROJECT_AGENTS_CAPABILITY = "project_agents_registry";

const INVALID_WORKSPACE_ERROR_CODES = new Set([
  "workspace_not_found",
  "workspace_not_directory",
  "workspace_validation_failed",
]);

export class ProjectBindingValidationError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ProjectBindingValidationError";
    this.status = status;
    this.code = code;
  }
}

export type ValidatedProjectBinding = {
  daemonHost: string;
  workspacePath: string;
  repoRoot: string | null;
  worktreeBranch: string | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
  gitRemoteUrl: string | null;
  fileCount: number | null;
  icon?: string | null;
  agents?: AgentRegistryEntry[];
};

export async function validateProjectBindingWithDaemon(params: {
  userId: string;
  daemonHost: string;
  workspacePath: string;
  timeoutMs?: number;
}): Promise<ValidatedProjectBinding> {
  const { userId, daemonHost, workspacePath } = params;
  const timeoutMs = params.timeoutMs ?? PROJECT_PATH_VALIDATION_TIMEOUT_MS;

  if (!realtimeHub.hasAgentHost(daemonHost, userId)) {
    throw new ProjectBindingValidationError(
      `Daemon ${daemonHost} is offline. Reconnect it before creating this project.`,
      409,
      "daemon_offline",
    );
  }

  const daemonConnection = realtimeHub
    .getAgentsForUser(userId)
    .find((agent) => agent.host === daemonHost);
  if (
    daemonConnection &&
    !daemonConnection.capabilities.some(
      (capability) => capability.trim().toLowerCase() === PROJECT_PATH_VALIDATION_CAPABILITY,
    )
  ) {
    throw new ProjectBindingValidationError(
      `Daemon ${daemonHost} is online but does not support workspace validation. Upgrade conductor daemon before creating this project.`,
      409,
      "daemon_upgrade_required",
    );
  }

  const requestId = randomUUID();
  const waitForValidation = realtimeHub.waitForProjectPathValidation(requestId, timeoutMs);
  const sent = realtimeHub.sendToAgentHost(userId, daemonHost, {
    type: "validate_project_path",
    payload: {
      request_id: requestId,
      workspace_path: workspacePath,
    },
  });
  if (!sent) {
    realtimeHub.cancelProjectPathValidation(requestId);
    throw new ProjectBindingValidationError(
      `Failed to contact daemon ${daemonHost} for workspace validation.`,
      409,
      "daemon_unreachable",
    );
  }

  const result = await waitForValidation;
  if (!result) {
    throw new ProjectBindingValidationError(
      `Timed out waiting for daemon ${daemonHost} to validate ${workspacePath}.`,
      409,
      "validation_timeout",
    );
  }

  if (result.error) {
    const code = result.error_code ?? undefined;
    throw new ProjectBindingValidationError(
      result.error,
      INVALID_WORKSPACE_ERROR_CODES.has(result.error_code ?? "") ? 400 : 409,
      code,
    );
  }

  if (!result.workspace_path) {
    throw new ProjectBindingValidationError(
      `Daemon ${daemonHost} returned no confirmed workspace path.`,
      409,
      "missing_workspace_path",
    );
  }

  return {
    daemonHost: result.daemon_host || daemonHost,
    workspacePath: result.workspace_path,
    repoRoot: result.repo_root,
    worktreeBranch: result.worktree_branch,
    lastCommit: result.last_commit,
    lastCommitAt: result.last_commit_at,
    gitRemoteUrl: result.git_remote_url ?? null,
    fileCount: result.file_count,
    icon: Object.prototype.hasOwnProperty.call(result, "icon") ? result.icon ?? null : undefined,
    agents: Object.prototype.hasOwnProperty.call(result, "agents")
      ? result.agents ?? []
      : undefined,
  };
}

/**
 * Resolve the current agent registry from the daemon that owns the workspace.
 *
 * The Web process cannot normally read a remote daemon's filesystem, so a live
 * daemon registry request is the authoritative source. This uses a dedicated
 * lightweight protocol that only reads YAML; it deliberately does not reuse
 * project-path validation, whose Git snapshot work is too expensive for every
 * task-composer open. Local reads remain a fail-soft fallback for self-hosted
 * deployments and older daemons.
 */
export async function resolveProjectAgentsRegistry(params: {
  userId: string;
  daemonHost: string | null | undefined;
  workspacePath: string | null | undefined;
}): Promise<AgentRegistryEntry[]> {
  const readLocalRegistry = () => readProjectAgentsRegistry(params.workspacePath);
  const daemonHost =
    typeof params.daemonHost === "string" ? params.daemonHost.trim() : "";
  const workspacePath =
    typeof params.workspacePath === "string" ? params.workspacePath.trim() : "";

  if (!daemonHost || !workspacePath || !realtimeHub.hasAgentHost(daemonHost, params.userId)) {
    return readLocalRegistry();
  }

  const daemonConnection = realtimeHub
    .getAgentsForUser(params.userId)
    .find((agent) => agent.host === daemonHost);
  const supportsAgentRegistry = daemonConnection?.capabilities.some(
    (capability) =>
      capability.trim().toLowerCase() === PROJECT_AGENTS_CAPABILITY,
  );
  if (!supportsAgentRegistry) {
    return readLocalRegistry();
  }

  const requestId = randomUUID();
  const waitForAgents = realtimeHub.waitForProjectAgents(
    requestId,
    PROJECT_AGENTS_TIMEOUT_MS,
  );
  const sent = realtimeHub.sendToAgentHost(params.userId, daemonHost, {
    type: "get_project_agents",
    payload: {
      request_id: requestId,
      workspace_path: workspacePath,
    },
  });
  if (!sent) {
    realtimeHub.cancelProjectAgents(requestId);
    return readLocalRegistry();
  }

  const result = await waitForAgents;
  if (result && !result.error) {
    return result.agents;
  }
  return readLocalRegistry();
}

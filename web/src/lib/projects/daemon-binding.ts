import { randomUUID } from "crypto";
import { realtimeHub } from "@/lib/realtime/hub";

const PROJECT_PATH_VALIDATION_TIMEOUT_MS = 5_000;
const PROJECT_PATH_VALIDATION_CAPABILITY = "project_path_validation";

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
  };
}

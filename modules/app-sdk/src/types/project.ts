/**
 * Project: a workspace binding (daemon + filesystem path) inside which tasks
 * are scoped. Maps to Conductor's Project model.
 *
 * `daemonHost` and `workspacePath` are the binding identity. App-SDK's
 * `projects.bind()` is idempotent on this pair.
 */
export interface Project {
  id: string;
  name: string;
  daemonHost: string | null;
  workspacePath: string | null;
  repoRoot: string | null;
  worktreeBranch: string | null;
  lastCommit: string | null;
  lastCommitAt: string | null;
  fileCount: number | null;
  isDefault: boolean;
  /**
   * True when this project was created via the App SDK (audit hint, derived
   * from `metadata.audit.createdByApp`). Read-only flag for UI affordances.
   */
  createdByApp: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BindProjectInput {
  name: string;
  daemonHost: string;
  workspacePath: string;
  /**
   * Optional override for the audit `createdByApp.name` field. Defaults to the
   * `name` argument. Only used when the SDK has to create a new project (no
   * existing binding found).
   */
  appLabel?: string;
}

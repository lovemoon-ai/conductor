import type { TaskStatus, RestartStrategy, RestartResultMode } from "@/shared/types";

export type { RestartStrategy, RestartResultMode } from "@/shared/types";

export const STOPPED_TASK_STATUSES = new Set<TaskStatus>(["completed", "killed", "unknown"]);
export const RESTARTABLE_SOURCE_STATUSES = new Set<TaskStatus>([
  "running",
  "completed",
  "killed",
  "unknown",
]);

export const normalizeRestartStrategy = (value: unknown): RestartStrategy | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "inplace") {
    return "inplace";
  }
  if (normalized === "new_task" || normalized === "newtask" || normalized === "successor") {
    return "new_task";
  }
  return null;
};

/**
 * Whether the server is willing to create a successor task across the given
 * backend pair. Since the share-link handoff is backend-agnostic (the target
 * AI just fetches a plain-text transcript URL), the only architectural
 * requirement here is that both backend names are non-empty.
 *
 * The ACTUAL per-pair reachability gate lives in the restart route, which
 * checks `supportedBackends.includes(targetBackend)` against the live
 * daemon agent. This function is the named extension point if we ever want
 * to add server-side policy (e.g., "backend X has no webfetch capability,
 * cannot be a handoff target"); today it's intentionally permissive.
 */
export const canCreateSuccessorTask = (
  sourceBackend: string,
  targetBackend: string,
): boolean => Boolean(sourceBackend) && Boolean(targetBackend);

export const canInplaceRestart = (
  status: TaskStatus | string,
  sourceBackend: string,
  targetBackend: string,
): boolean => STOPPED_TASK_STATUSES.has(status as TaskStatus) && sourceBackend === targetBackend;

/**
 * Filter the daemon's advertised backend list to those that are valid
 * successor targets for this source. In practice this just strips empty
 * strings, but the indirection keeps the UI symmetric with the API route
 * (both go through `canCreateSuccessorTask`) so a future policy tweak
 * lands in one place.
 */
export const getCompatibleRestartBackends = (
  sourceBackend: string,
  supportedBackends: string[],
): string[] =>
  supportedBackends.filter((backend) => canCreateSuccessorTask(sourceBackend, backend));

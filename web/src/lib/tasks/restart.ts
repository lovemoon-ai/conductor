import type { TaskStatus } from "@/lib/conductor/types";

export type RestartStrategy = "inplace" | "new_task";
export type RestartResultMode =
  | "inplace_restart"
  | "backend_switch_new_task"
  | "successor_new_task";

export const STOPPED_TASK_STATUSES = new Set<TaskStatus>(["completed", "killed"]);
export const RESTARTABLE_SOURCE_STATUSES = new Set<TaskStatus>([
  "running",
  "completed",
  "killed",
]);
export const BRIDGEABLE_BACKENDS = new Set(["codex", "claude", "kimi"]);
export const VALID_RESTART_BACKENDS = new Set(["codex", "claude", "kimi", "opencode"]);

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

export const canBridgeBackends = (sourceBackend: string, targetBackend: string): boolean =>
  BRIDGEABLE_BACKENDS.has(sourceBackend) && BRIDGEABLE_BACKENDS.has(targetBackend);

export const canCreateSuccessorTask = (
  sourceBackend: string,
  targetBackend: string,
): boolean => sourceBackend === targetBackend || canBridgeBackends(sourceBackend, targetBackend);

export const canInplaceRestart = (
  status: TaskStatus | string,
  sourceBackend: string,
  targetBackend: string,
): boolean => STOPPED_TASK_STATUSES.has(status as TaskStatus) && sourceBackend === targetBackend;

export const getCompatibleRestartBackends = (
  sourceBackend: string,
  supportedBackends: string[],
): string[] =>
  supportedBackends.filter(
    (backend) => VALID_RESTART_BACKENDS.has(backend) && canCreateSuccessorTask(sourceBackend, backend),
  );

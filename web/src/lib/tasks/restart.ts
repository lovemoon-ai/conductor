import type { TaskStatus, RestartStrategy, RestartResultMode } from "@/shared/types";

export type { RestartStrategy, RestartResultMode } from "@/shared/types";
export type RestartRuntimeBackendMap = Record<string, string>;
export type RestartCompatibilityOptions = {
  sourceRuntimeBackendMap?: RestartRuntimeBackendMap | null;
  targetRuntimeBackendMap?: RestartRuntimeBackendMap | null;
};
export type RestartBackendListOptions = {
  runtimeBackendMap?: RestartRuntimeBackendMap | null;
};

export const STOPPED_TASK_STATUSES = new Set<TaskStatus>(["completed", "killed", "unknown"]);
export const RESTARTABLE_SOURCE_STATUSES = new Set<TaskStatus>([
  "running",
  "completed",
  "killed",
  "unknown",
]);
export const BRIDGEABLE_BACKENDS = new Set(["codex", "claude", "kimi"]);
const RESTART_BACKEND_ALIASES = new Map([
  ["code", "codex"],
  ["claude-code", "claude"],
  ["kimi-cli", "kimi"],
  ["kimi-code", "kimi"],
]);

export const normalizeRestartBackend = (
  backend: string,
  runtimeBackendMap?: RestartRuntimeBackendMap | null,
): string => {
  const normalized = typeof backend === "string" ? backend.trim().toLowerCase() : "";
  if (!normalized) {
    return "";
  }
  const aliasedBackend = RESTART_BACKEND_ALIASES.get(normalized);
  if (aliasedBackend) {
    return aliasedBackend;
  }
  const mappedRuntimeBackend =
    runtimeBackendMap && typeof runtimeBackendMap[normalized] === "string"
      ? runtimeBackendMap[normalized].trim().toLowerCase()
      : "";
  if (mappedRuntimeBackend) {
    return RESTART_BACKEND_ALIASES.get(mappedRuntimeBackend) ?? mappedRuntimeBackend;
  }
  if (BRIDGEABLE_BACKENDS.has(normalized)) {
    return normalized;
  }
  return normalized;
};

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

export const canBridgeBackends = (
  sourceBackend: string,
  targetBackend: string,
  options: RestartCompatibilityOptions = {},
): boolean =>
  BRIDGEABLE_BACKENDS.has(normalizeRestartBackend(sourceBackend, options.sourceRuntimeBackendMap)) &&
  BRIDGEABLE_BACKENDS.has(normalizeRestartBackend(targetBackend, options.targetRuntimeBackendMap));

export const canCreateSuccessorTask = (
  sourceBackend: string,
  targetBackend: string,
  options: RestartCompatibilityOptions = {},
): boolean =>
  sourceBackend === targetBackend ||
  normalizeRestartBackend(sourceBackend, options.sourceRuntimeBackendMap) ===
    normalizeRestartBackend(targetBackend, options.targetRuntimeBackendMap) ||
  canBridgeBackends(sourceBackend, targetBackend, options);

export const canInplaceRestart = (
  status: TaskStatus | string,
  sourceBackend: string,
  targetBackend: string,
): boolean => STOPPED_TASK_STATUSES.has(status as TaskStatus) && sourceBackend === targetBackend;

export const getCompatibleRestartBackends = (
  sourceBackend: string,
  supportedBackends: string[],
  options: RestartBackendListOptions = {},
): string[] =>
  supportedBackends.filter((backend) =>
    canCreateSuccessorTask(sourceBackend, backend, {
      sourceRuntimeBackendMap: options.runtimeBackendMap,
      targetRuntimeBackendMap: options.runtimeBackendMap,
    })
  );

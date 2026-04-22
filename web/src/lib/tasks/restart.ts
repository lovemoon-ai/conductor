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
// Historical name — kept as an export for backwards compat with any external
// consumer that imported it, but no longer used as a gate. The handoff path
// is now backend-agnostic: any two backends that the target daemon advertises
// as `supportedBackends` can be paired. Cross-backend restart ships the prior
// conversation as plain text at /share/<token>/plain, so the target AI only
// needs to be able to fetch the URL (a capability every mainstream coding
// assistant CLI has). See claw/rfc/0021-feature-task-restart.md.
export const BRIDGEABLE_BACKENDS = new Set(["codex", "claude", "kimi", "opencode"]);
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

/**
 * Whether a cross-backend handoff is architecturally supported. Since the
 * handoff mechanism is backend-agnostic (the target AI just fetches a
 * plain-text transcript URL), the only hard requirements are:
 *
 *   1. Both backend names resolve (non-empty after normalization).
 *   2. The target daemon advertises support for the target backend — the
 *      restart route enforces this independently via the online-agent
 *      `supportedBackends` check, so this function does not duplicate it.
 *
 * Backend identity (codex vs claude vs kimi vs opencode vs any custom
 * AISDK_PROVIDER_PATH provider) is not gated here. A bespoke provider that
 * has no web-fetch capability will surface at runtime as "target AI says it
 * can't reach the URL" — see the handoff prompt in
 * `cli/src/daemon.js::buildResumeHandoffPrompt`, which asks the target AI
 * to fall back to a recap if the fetch fails.
 */
export const canBridgeBackends = (
  sourceBackend: string,
  targetBackend: string,
  options: RestartCompatibilityOptions = {},
): boolean => {
  const source = normalizeRestartBackend(sourceBackend, options.sourceRuntimeBackendMap);
  const target = normalizeRestartBackend(targetBackend, options.targetRuntimeBackendMap);
  return Boolean(source) && Boolean(target);
};

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

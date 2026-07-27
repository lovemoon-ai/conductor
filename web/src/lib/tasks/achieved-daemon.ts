import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import {
  normalizeOptionalString,
  parseJsonObject,
} from "@/lib/tasks/task-config";

type AchievedDaemonTask = {
  agentHost?: string | null;
  executionHost?: string | null;
  metadata?: unknown;
  project?: { daemonHost?: string | null } | null;
};

/**
 * Resolve the daemon that originally owns an archived task.
 *
 * App tasks follow the current project binding first. Manual-fire tasks store
 * their actual daemon association in metadata.daemonName while agentHost /
 * executionHost may both point at the ephemeral conductor-fire process.
 */
export const resolveAchievedTaskDaemonHost = (
  task: AchievedDaemonTask,
): string | null => {
  const projectDaemonHost = normalizeOptionalString(task.project?.daemonHost);
  const agentHost = normalizeOptionalString(task.agentHost);
  const executionHost = normalizeOptionalString(task.executionHost);
  const metadataDaemonHost = normalizeOptionalString(
    parseJsonObject(task.metadata)?.daemonName,
  );

  if (agentHost && isConductorFireHost(agentHost)) {
    return (
      (metadataDaemonHost && !isConductorFireHost(metadataDaemonHost)
        ? metadataDaemonHost
        : null) ??
      (executionHost && !isConductorFireHost(executionHost)
        ? executionHost
        : null) ??
      (projectDaemonHost && !isConductorFireHost(projectDaemonHost)
        ? projectDaemonHost
        : null)
    );
  }

  return (
    (projectDaemonHost && !isConductorFireHost(projectDaemonHost)
      ? projectDaemonHost
      : null) ??
    (agentHost && !isConductorFireHost(agentHost) ? agentHost : null) ??
    (metadataDaemonHost && !isConductorFireHost(metadataDaemonHost)
      ? metadataDaemonHost
      : null) ??
    (executionHost && !isConductorFireHost(executionHost)
      ? executionHost
      : null)
  );
};

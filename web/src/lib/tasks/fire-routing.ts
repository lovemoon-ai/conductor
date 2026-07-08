import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import { parseJsonObject, normalizeOptionalString } from "@/lib/tasks/task-config";

/**
 * Shared fire-owner / daemon routing resolution for per-turn control commands
 * (interrupt, insert). Extracted from the interrupt route so the insert route
 * can reuse the exact same routing behavior. Pure function — no behavior change
 * from the original inline implementation.
 */
export type FireRouteTask = {
  id: string;
  projectId: string;
  taskType: string | null;
  status: string | null;
  agentHost: string | null;
  executionHost: string | null;
  metadata: unknown;
  project: {
    daemonHost: string | null;
  } | null;
};

const extractMetadataDaemonHost = (value: unknown): string | null =>
  normalizeOptionalString(parseJsonObject(value)?.daemonName);

const uniqueHosts = (hosts: Array<string | null>): string[] =>
  hosts.filter((value, index, array): value is string => Boolean(value) && array.indexOf(value) === index);

export const resolveFireTaskRouting = (task: FireRouteTask, boundHost: string | null) => {
  const configuredAgentHost = normalizeOptionalString(task.agentHost);
  const executionHost = normalizeOptionalString(task.executionHost);
  const metadataDaemonHost = extractMetadataDaemonHost(task.metadata);
  const projectDaemonHost = normalizeOptionalString(task.project?.daemonHost);
  const normalizedBoundHost = normalizeOptionalString(boundHost);
  const isManualFireTask = Boolean(configuredAgentHost && isConductorFireHost(configuredAgentHost));

  const persistedFireOwnerCandidates = uniqueHosts([
    executionHost && isConductorFireHost(executionHost) ? executionHost : null,
    configuredAgentHost && isConductorFireHost(configuredAgentHost) ? configuredAgentHost : null,
  ]);
  const boundFireOwnerCandidate =
    normalizedBoundHost &&
    isConductorFireHost(normalizedBoundHost) &&
    (persistedFireOwnerCandidates.length === 0 || persistedFireOwnerCandidates.includes(normalizedBoundHost))
      ? normalizedBoundHost
      : null;
  const fireOwnerCandidates = isManualFireTask
    ? uniqueHosts([boundFireOwnerCandidate, ...persistedFireOwnerCandidates])
    : uniqueHosts([executionHost && isConductorFireHost(executionHost) ? executionHost : null]);

  const daemonAssociationCandidates = uniqueHosts(
    isManualFireTask
      ? [
          metadataDaemonHost && !isConductorFireHost(metadataDaemonHost) ? metadataDaemonHost : null,
          executionHost && !isConductorFireHost(executionHost) ? executionHost : null,
          projectDaemonHost && !isConductorFireHost(projectDaemonHost) ? projectDaemonHost : null,
        ]
      : [
          configuredAgentHost && !isConductorFireHost(configuredAgentHost) ? configuredAgentHost : null,
          metadataDaemonHost && !isConductorFireHost(metadataDaemonHost) ? metadataDaemonHost : null,
          executionHost && !isConductorFireHost(executionHost) ? executionHost : null,
          projectDaemonHost && !isConductorFireHost(projectDaemonHost) ? projectDaemonHost : null,
        ],
  );

  return {
    taskModel: isManualFireTask ? "manual_fire" : "app",
    fireOwnerHost: fireOwnerCandidates[0] ?? null,
    fireOwnerCandidates,
    daemonAssociationHost: daemonAssociationCandidates[0] ?? null,
  };
};

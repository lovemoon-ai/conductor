export type TaskPlanBucket = "manual_fire" | "app";

export type ActiveTaskCounts = {
  manualFire: number;
  app: number;
};

import { normalizeTaskStatus } from "@/lib/tasks/task-config";

const TERMINAL_TASK_STATUSES = new Set(["completed", "killed"]);

export const isConductorFireHost = (host: unknown): host is string =>
  typeof host === "string" && host.startsWith("conductor-fire-");

export const isTaskActive = (status: unknown): boolean =>
  !TERMINAL_TASK_STATUSES.has(normalizeTaskStatus(status));

export const getTaskPlanBucket = (agentHost: unknown): TaskPlanBucket =>
  isConductorFireHost(agentHost) ? "manual_fire" : "app";

export const isFreeTier = (_tier: unknown): boolean => false;

export const countActiveTaskBuckets = (
  tasks: Array<{ status: unknown; agentHost: unknown }>
): ActiveTaskCounts => {
  const counts: ActiveTaskCounts = { manualFire: 0, app: 0 };
  for (const task of tasks) {
    if (!isTaskActive(task.status)) continue;
    if (getTaskPlanBucket(task.agentHost) === "manual_fire") {
      counts.manualFire += 1;
    } else {
      counts.app += 1;
    }
  }
  return counts;
};

export const exceedsFreeTaskLimit = (
  _bucket: TaskPlanBucket,
  _counts: ActiveTaskCounts
): boolean => false;

export const getFreeTaskLimitMessage = (_bucket: TaskPlanBucket): string => "";

export const exceedsTaskLimit = (
  _tier: unknown,
  _bucket: TaskPlanBucket,
  _counts: ActiveTaskCounts
): boolean => false;

export const getTaskLimitMessage = (_tier: unknown, _bucket: TaskPlanBucket): string => "";

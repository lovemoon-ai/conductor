export const FREE_PLAN_LIMITS = {
  activeManualFireTasks: 1,
  activeAppTasks: 1,
  activeDaemonConnections: 1,
} as const;

export const PLUS_PLAN_LIMITS = {
  activeManualFireTasks: 10,
  activeAppTasks: 10,
  activeDaemonConnections: 10,
} as const;

export type TaskPlanBucket = "manual_fire" | "app";

export type ActiveTaskCounts = {
  manualFire: number;
  app: number;
};

const PLUS_TIERS = new Set(["PLUS", "PLUS_DEV"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "killed"]);

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "running") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

export const isConductorFireHost = (host: unknown): host is string =>
  typeof host === "string" && host.startsWith("conductor-fire-");

export const isTaskActive = (status: unknown): boolean =>
  !TERMINAL_TASK_STATUSES.has(normalizeTaskStatus(status));

export const getTaskPlanBucket = (agentHost: unknown): TaskPlanBucket =>
  isConductorFireHost(agentHost) ? "manual_fire" : "app";

export const isFreeTier = (tier: unknown): boolean => {
  const normalizedTier = typeof tier === "string" ? tier.trim().toUpperCase() : "";
  return !PLUS_TIERS.has(normalizedTier);
};

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
  bucket: TaskPlanBucket,
  counts: ActiveTaskCounts
): boolean =>
  bucket === "manual_fire"
    ? counts.manualFire >= FREE_PLAN_LIMITS.activeManualFireTasks
    : counts.app >= FREE_PLAN_LIMITS.activeAppTasks;

export const getFreeTaskLimitMessage = (bucket: TaskPlanBucket): string =>
  bucket === "manual_fire"
    ? "Free plan allows only one active manual fire task"
    : "Free plan allows only one active app task";

/**
 * Check if the task limit is exceeded for the given tier and bucket.
 * This is the unified function that works for both Free and Plus tiers.
 */
export const exceedsTaskLimit = (
  tier: unknown,
  bucket: TaskPlanBucket,
  counts: ActiveTaskCounts
): boolean => {
  if (isFreeTier(tier)) {
    return bucket === "manual_fire"
      ? counts.manualFire >= FREE_PLAN_LIMITS.activeManualFireTasks
      : counts.app >= FREE_PLAN_LIMITS.activeAppTasks;
  }
  // Plus tier
  return bucket === "manual_fire"
    ? counts.manualFire >= PLUS_PLAN_LIMITS.activeManualFireTasks
    : counts.app >= PLUS_PLAN_LIMITS.activeAppTasks;
};

export const getTaskLimitMessage = (tier: unknown, bucket: TaskPlanBucket): string => {
  if (isFreeTier(tier)) {
    return bucket === "manual_fire"
      ? "Free plan allows only one active manual fire task"
      : "Free plan allows only one active app task";
  }
  // Plus tier
  return bucket === "manual_fire"
    ? "Plus plan allows only ten active manual fire tasks"
    : "Plus plan allows only ten active app tasks";
};

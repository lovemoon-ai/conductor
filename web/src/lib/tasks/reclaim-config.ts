// RFC 0029: Task Reclaim on Restart — runtime feature flag.
//
// Rollout plan:
//   Phase 1 (this commit): flag default `false` → behavior unchanged for
//   prod and for daemons that haven't deployed reclaim_task handlers yet.
//   Phase 2/3 dogfooding flips it to `true` on the dev daemon, then to a
//   percentage gate; finally Phase 4 defaults to `true`.
//
// Acceptable truthy values: "1", "true", "yes", "on" (case-insensitive).
// Anything else (including unset) is treated as disabled so we never
// surprise an operator who has not opted in.

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export const TASK_RECLAIM_ENV_VAR = "CONDUCTOR_TASK_RECLAIM_ENABLED";

export const isTaskReclaimEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const raw = env[TASK_RECLAIM_ENV_VAR];
  if (typeof raw !== "string") return false;
  return TRUTHY.has(raw.trim().toLowerCase());
};

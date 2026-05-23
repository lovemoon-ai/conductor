import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import {
  buildKilledPatch,
  withKilledReasonFallback,
} from "@/lib/tasks/killed-reason";

export type RecoverableTaskRecord = {
  id: string;
  projectId: string;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  createdAt: Date;
  updatedAt?: Date | null;
};

const normalizeHost = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.trim();
};

const normalizeTaskStatus = (value: unknown): string => {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "init") return "init";
  if (normalized === "running") return "running";
  if (normalized === "killing" || normalized === "stopping") return "killing";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return "unknown";
};

const isTerminalTaskStatus = (status: string): boolean =>
  status === "completed" || status === "killed";

const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const STALE_FIRE_TASK_RECOVERY_TIMEOUT_MS = parsePositiveInt(
  process.env.CONDUCTOR_STALE_FIRE_TASK_RECOVERY_TIMEOUT_MS,
  30_000,
);

const STALE_DAEMON_TASK_RECOVERY_TIMEOUT_MS = parsePositiveInt(
  process.env.CONDUCTOR_STALE_DAEMON_TASK_RECOVERY_TIMEOUT_MS,
  120_000,
);

// Captured at module load so the recovery path can refuse to kill tasks just
// because the in-memory realtimeHub registry is empty after a fresh Web boot,
// a websocket dropout, or load-balanced traffic landing on an instance the
// agent never connected to. Without this, recover_stale=1 (which fires on any
// task list/detail refresh) would mark a perfectly healthy Codex/fire session
// as `killed` even though it keeps generating messages — the "split-brain"
// stale-recovery bug. See claw/lessons/stable_recover_stale_split_brain_kill_20260425.md
const WEB_INSTANCE_STARTED_AT = Date.now();

export async function recoverStaleDisconnectedAgentTasks(
  userId: string,
  tasks: RecoverableTaskRecord[],
): Promise<void> {
  if (tasks.length === 0) return;

  const now = Date.now();
  const recoveries: Array<Promise<void>> = [];

  for (const task of tasks) {
    const executionHost = normalizeHost(task.executionHost);
    const boundHost = normalizeHost(realtimeHub.getTaskAgentHost(task.id));
    const configuredHost = normalizeHost(task.agentHost);
    const recoveryHost = boundHost || executionHost || configuredHost;
    if (!recoveryHost) continue;

    const normalizedStatus = normalizeTaskStatus(task.status);
    if (isTerminalTaskStatus(normalizedStatus)) continue;
    // Skip init tasks: they may be waiting for a restart_task message
    // to be delivered via agentOutbox (e.g. branch/fork creates a successor
    // task with status "init" that the daemon hasn't started yet).
    if (normalizedStatus === "init") continue;
    if (realtimeHub.hasAgentHost(recoveryHost, userId)) continue;

    const recoveryTimeoutMs = isConductorFireHost(recoveryHost)
      ? STALE_FIRE_TASK_RECOVERY_TIMEOUT_MS
      : STALE_DAEMON_TASK_RECOVERY_TIMEOUT_MS;

    const disconnectAt =
      typeof (realtimeHub as any).getAgentDisconnectAt === "function"
        ? (realtimeHub as any).getAgentDisconnectAt(recoveryHost, userId)
        : null;
    const lastActivityMs = (
      task.updatedAt instanceof Date ? task.updatedAt : task.createdAt
    )?.getTime?.();
    // When this Web instance has no record of the agent ever
    // connecting/disconnecting (fresh boot, websocket flap, or another
    // instance is the one actually holding the agent socket), do NOT trust
    // the persisted `task.updatedAt` alone — that timestamp predates this
    // process and cannot prove the agent is dead. Floor the offline-since
    // clock at the instance start time so the agent always gets at least
    // `recoveryTimeoutMs` after boot to reconnect before we declare the task
    // killed. This prevents a recover_stale list refresh right after a Web
    // restart from issuing "split-brain" kills against still-running Codex
    // sessions.
    const fallbackOfflineSince = Number.isFinite(lastActivityMs)
      ? Math.max(Number(lastActivityMs), WEB_INSTANCE_STARTED_AT)
      : WEB_INSTANCE_STARTED_AT;
    const offlineSince =
      typeof disconnectAt === "number" ? disconnectAt : fallbackOfflineSince;
    if (!Number.isFinite(offlineSince)) continue;
    if (now - Number(offlineSince) < recoveryTimeoutMs) continue;

    recoveries.push((async () => {
      // RFC 0029: this is the *defensive* kill path (agent ws went stale).
      // Tag with `daemon_disconnected` so the restart route can attempt a
      // reclaim against the still-alive fire instead of spawning a new one.
      const killedPatch = buildKilledPatch("daemon_disconnected");
      await withKilledReasonFallback(
        () =>
          db.task.update({
            where: { id: task.id },
            data: {
              ...killedPatch,
              executionHost: null,
            },
          }),
        () =>
          db.task.update({
            where: { id: task.id },
            data: {
              status: "killed",
              executionHost: null,
            },
          }),
      );
      task.status = "killed";
      task.executionHost = null;
      if (typeof (realtimeHub as any).unbindTask === "function") {
        (realtimeHub as any).unbindTask(task.id);
      }
      if (typeof (realtimeHub as any).notifyTaskStatus === "function") {
        (realtimeHub as any).notifyTaskStatus(task.id, "killed");
      }
      realtimeHub.broadcast(userId, task.projectId, {
        type: "task_status_update",
        payload: {
          task_id: task.id,
          project_id: task.projectId,
          status: "killed",
          summary: "Recovered after agent disconnect timeout",
        },
      });
    })());
  }

  if (recoveries.length > 0) {
    await Promise.all(recoveries);
  }
}

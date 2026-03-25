import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";

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
    const offlineSince = typeof disconnectAt === "number" ? disconnectAt : lastActivityMs;
    if (!Number.isFinite(offlineSince)) continue;
    if (now - Number(offlineSince) < recoveryTimeoutMs) continue;

    recoveries.push((async () => {
      await db.task.update({
        where: { id: task.id },
        data: {
          status: "killed",
          executionHost: null,
        },
      });
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

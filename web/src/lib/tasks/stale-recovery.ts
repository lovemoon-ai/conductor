import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import {
  enqueueAndAttemptAgentCommand,
  isMissingAgentOutboxTableError,
} from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import {
  buildKilledPatch,
  withKilledReasonFallback,
} from "@/lib/tasks/killed-reason";
import { resolveKillingElapsedMs } from "@/lib/tasks/task-config";

export type RecoverableTaskRecord = {
  id: string;
  projectId: string;
  status: string;
  agentHost: string | null;
  executionHost: string | null;
  taskType?: string | null;
  createdAt: Date;
  updatedAt?: Date | null;
  /** Raw JSON string; read for `killingStartedAt` when converging a stuck stop. */
  metadata?: string | null;
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

const UNSAFE_HOST_SEGMENT = /[^A-Za-z0-9._-]+/g;

/**
 * Fire hosts that may serve a daemon-launched ai_task, most specific first;
 * empty when the task is not one. Only a fire can take user messages for such
 * a task (see resolveTaskUserMessageFireHost), so its liveness — not the
 * daemon's — says whether the task is usable. The last candidate mirrors
 * buildFireHostName in modules/conductor-sdk/src/agent-host.ts for the env the
 * daemon launches fires with, so the fire is still identifiable after
 * executionHost was cleared.
 */
export const listDaemonTaskFireHosts = (
  task: { id: string; taskType?: string | null; agentHost?: string | null; executionHost?: string | null },
  boundHost?: string | null,
): string[] => {
  const daemonHost = normalizeHost(task.agentHost);
  // Not narrowed through `daemonHost`: the type guard would make it `never`.
  if (task.taskType !== "ai_task" || !daemonHost || isConductorFireHost(normalizeHost(task.agentHost))) return [];
  const derivedHost = `conductor-fire-${daemonHost.replace(UNSAFE_HOST_SEGMENT, "-")}-${task.id.replace(UNSAFE_HOST_SEGMENT, "-")}`;
  return Array.from(
    new Set([normalizeHost(task.executionHost), normalizeHost(boundHost), derivedHost].filter(isConductorFireHost)),
  );
};

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

// How long a task may sit in `killing` before the server stops waiting for the
// agent and converges it itself.
//
// `killing` is a promise that some agent will report a terminal status back.
// When that promise is broken the row is stranded forever: the status is not
// terminal (so the recovery sweep below used to skip it), the agent host is
// typically still connected (so the offline path never triggers), and the
// PATCH API refuses to move it (see the `killing` branch in
// web/src/app/api/tasks/[taskId]/route.ts). The observed break is a daemon
// that receives `stop_task`, finds no live fire, and answers only with a
// command ack — it has nothing to report a status *about*.
//
// Deliberately much longer than the 60s countdown the UI renders: that value
// is a progress hint for humans, whereas this one force-ends a stop that may
// still be legitimately draining on a slow or busy machine. Overshooting costs
// a few stale minutes in the list; undershooting kills healthy sessions.
const KILLING_CONVERGENCE_TIMEOUT_MS = parsePositiveInt(
  process.env.CONDUCTOR_KILLING_CONVERGENCE_TIMEOUT_MS,
  300_000,
);


// Captured at module load so the recovery path can refuse to kill tasks just
// because the in-memory realtimeHub registry is empty after a fresh Web boot,
// a websocket dropout, or load-balanced traffic landing on an instance the
// agent never connected to. Without this, recover_stale=1 (which fires on any
// task list/detail refresh) would mark a perfectly healthy Codex/fire session
// as `killed` even though it keeps generating messages — the "split-brain"
// stale-recovery bug. See claw/lessons/stable_recover_stale_split_brain_kill_20260425.md
const WEB_INSTANCE_STARTED_AT = Date.now();

// The defensive kill path only flips the DB row to `killed`; it never delivers
// a `stop_task` to the agent. If the agent's backend (Codex / `conductor fire`)
// is actually still alive — its websocket merely flapped, or it was launched in
// a detached tmux and its socket dropped without the process dying — nothing
// tells it to stop, so it keeps streaming replies against the now-killed task
// (the "split-brain zombie"). Enqueue a durable `stop_task` into the agent
// outbox so that whenever that host's socket reconnects, the pending command is
// drained to it and the backend session is actually interrupted. We enqueue
// (persist) and do not require immediate delivery: usually the host is offline.
// When it is the fire's still-connected daemon, the attempt delivers at once
// instead of waiting for the outbox cron.
// See claw/lessons/stable_recover_stale_split_brain_kill_20260425.md
async function enqueueRecoveryStopTask(args: {
  userId: string;
  taskId: string;
  projectId: string;
  agentHost: string;
}): Promise<void> {
  try {
    // The outbox row id and the envelope's `request_id` MUST be the same value:
    // the fire echoes `request_id` in its `task_stop_ack`, and
    // acknowledgeAgentCommand clears the row by `requestId`. Two different UUIDs
    // would leave the row un-acked forever — re-sent on every drain and, if the
    // task is later reclaimed/restarted in-place under the same taskId, capable
    // of stopping the fresh run. Mirror the single-id invariant used by the
    // normal stop path in web/src/app/api/tasks/[taskId]/route.ts.
    const requestId = randomUUID();
    await enqueueAndAttemptAgentCommand(
      {
        userId: args.userId,
        agentHost: args.agentHost,
        taskId: args.taskId,
        eventType: "stop_task",
        requestId,
        envelope: {
          type: "stop_task",
          payload: {
            task_id: args.taskId,
            project_id: args.projectId,
            request_id: requestId,
            reason: "recovered_stale_disconnect",
          },
        },
      },
      {
        sendToAgentHost: ({ userId, agentHost, envelope }) =>
          realtimeHub.sendToAgentHost(userId, agentHost, envelope),
      },
    );
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) return;
    // Never let outbox bookkeeping fail the recovery itself — the DB row is
    // already killed; a missing stop_task only means the (possibly-dead) host
    // will not be re-stopped on reconnect.
    console.error(
      `[stale-recovery] failed to enqueue stop_task for task ${args.taskId} on ${args.agentHost}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

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

    // A `killing` task whose host is STILL CONNECTED is invisible to every
    // other branch here — the offline clock below never starts, so it would
    // stay mid-stop forever. Converge it on its own timeout instead.
    //
    // Unlike the defensive kill below this is NOT a disconnect: the user asked
    // for the stop and the agent simply never confirmed it, so tag
    // `user_stopped` (not reclaim-eligible — there is no healthy fire to
    // reattach to) and do NOT enqueue another `stop_task`. Entering `killing`
    // already persisted one durable stop command; adding a second would leave
    // an extra un-acked row that a later in-place restart could pick up and
    // use to shoot down the fresh run.
    if (normalizedStatus === "killing" && realtimeHub.hasAgentHost(recoveryHost, userId)) {
      const killingElapsedMs = resolveKillingElapsedMs(task.metadata, task.updatedAt, now);
      if (killingElapsedMs === null) continue;
      if (killingElapsedMs < KILLING_CONVERGENCE_TIMEOUT_MS) continue;

      recoveries.push((async () => {
        const killedPatch = buildKilledPatch("user_stopped");
        await withKilledReasonFallback(
          () =>
            db.task.update({
              where: { id: task.id },
              data: { ...killedPatch, executionHost: null },
            }),
          () =>
            db.task.update({
              where: { id: task.id },
              data: { status: "killed", executionHost: null },
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
            summary: "Stop timed out; agent never confirmed",
          },
        });
      })());
      continue;
    }

    // A daemon-launched ai_task lives or dies with its fire. A connected daemon
    // must not vouch for it: it is bound at boot and is the agentHost fallback
    // once executionHost is cleared, so checking it kept a fire that never
    // reconnected `running` forever while every user message got a 409.
    const fireHosts = listDaemonTaskFireHosts(task, boundHost);
    if (fireHosts.some((host) => realtimeHub.hasAgentHost(host, userId))) continue;
    // Fire gone but its daemon connected: the daemon owns the process, so it
    // gets the stop and can actually end it. Queued to the fire instead, the
    // stop could only land if that fire ever reconnected. Daemon offline too:
    // keep the plain path below, whose stop reaches a tmux fire that outlived
    // its daemon.
    const daemonGuardsFire = fireHosts.length > 0 && realtimeHub.hasAgentHost(configuredHost, userId);
    if (!daemonGuardsFire && realtimeHub.hasAgentHost(recoveryHost, userId)) continue;
    const stopHost = daemonGuardsFire ? configuredHost : recoveryHost;

    // The daemon's stop is delivered at once and cannot be taken back, so give
    // the fire's own 10s reconnect loop the longer window before using it.
    const recoveryTimeoutMs = !daemonGuardsFire && isConductorFireHost(recoveryHost)
      ? STALE_FIRE_TASK_RECOVERY_TIMEOUT_MS
      : STALE_DAEMON_TASK_RECOVERY_TIMEOUT_MS;

    const getDisconnectAt = (host: string): unknown =>
      typeof (realtimeHub as any).getAgentDisconnectAt === "function"
        ? (realtimeHub as any).getAgentDisconnectAt(host, userId)
        : null;
    const disconnectAt = daemonGuardsFire
      ? fireHosts.map(getDisconnectAt).find((value) => typeof value === "number")
      : getDisconnectAt(recoveryHost);
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
      // Durable stop so the (possibly still-alive) backend converges on
      // reconnect instead of streaming into a killed task.
      await enqueueRecoveryStopTask({
        userId,
        taskId: task.id,
        projectId: task.projectId,
        agentHost: stopHost,
      });
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

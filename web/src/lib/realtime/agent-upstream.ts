import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeMessageMetadata } from "@/shared/utils/message-attachments";
import {
  projectTaskMessage,
  projectTaskStatusUpdate,
} from "@/lib/channel/task-event-projector";
import {
  acknowledgeAgentCommand,
  deliverAgentOutboxForHost,
  enqueueAndAttemptAgentCommand,
  isMissingAgentOutboxTableError,
} from "@/lib/realtime/agent-outbox";
import { realtimeHub } from "@/lib/realtime/hub";
import { isConductorFireHost } from "@/lib/subscription/plan-limits";
import {
  isMissingAnyNewSchemaError,
  taskSelectWithoutIssueId,
} from "@/lib/tasks/pty-compat";
import {
  buildKilledPatch,
  withKilledReasonFallback,
  RECLAIMABLE_KILLED_REASON,
  type KilledReason,
} from "@/lib/tasks/killed-reason";

type TaskOwnershipRecord = {
  id: string;
  agentHost: string | null;
  executionHost: string | null;
  taskType?: string | null;
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

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const sendEnvelopeToAgentHost = (args: {
  userId: string;
  agentHost: string;
  envelope: { type: string; payload: Record<string, unknown> };
}): boolean => realtimeHub.sendToAgentHost(args.userId, args.agentHost, args.envelope);

export async function drainAgentOutboxForHost(
  userId: string,
  agentHost: string,
  options: { ignoreRetryAt?: boolean } = {},
): Promise<void> {
  try {
    const result = await deliverAgentOutboxForHost({
      userId,
      agentHost,
      ignoreRetryAt: options.ignoreRetryAt === true,
      sendToAgentHost: sendEnvelopeToAgentHost,
      resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
    });
    if (result.attempted > 0) {
      console.log(
        `[agent-upstream] drained outbox for ${agentHost}: attempted=${result.attempted} delivered=${result.delivered}`,
      );
    }
  } catch (error) {
    console.error(
      `[agent-upstream] failed to drain outbox for ${agentHost}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// Durably interrupt a still-streaming backend that belongs to an
// already-killed task. Uses a single requestId for both the outbox row and the
// envelope `request_id` so the fire's `task_stop_ack` can clear the row (a
// mismatch would leave it re-sending forever). Persist + attempt-now via the
// outbox so both transports are covered: an active ws is delivered immediately,
// while a fire on the stateless HTTP events path is stopped when its socket
// next drains. Never throws — dropping the zombie message must not depend on
// the stop succeeding.
async function stopKilledTaskBackend(args: {
  userId: string;
  agentHost: string;
  taskId: string;
  projectId: string;
}): Promise<void> {
  const requestId = randomUUID();
  try {
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
            reason: "task_already_killed",
          },
        },
      },
      {
        agentHost: args.agentHost,
        sendToAgentHost: sendEnvelopeToAgentHost,
        resolveTaskHost: (taskId) => realtimeHub.getTaskAgentHost(taskId),
      },
    );
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      // No durable outbox available — fall back to a best-effort direct send.
      realtimeHub.sendToAgentHost(args.userId, args.agentHost, {
        type: "stop_task",
        payload: {
          task_id: args.taskId,
          project_id: args.projectId,
          request_id: requestId,
          reason: "task_already_killed",
        },
      });
      return;
    }
    console.error(
      `[agent-upstream] failed to stop killed task ${args.taskId} on ${args.agentHost}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function persistTaskExecutionHost(
  userId: string,
  taskId: string,
  agentHost: string,
): Promise<void> {
  const normalizedHost = agentHost.trim();
  if (!normalizedHost) return;
  await db.task.updateMany({
    where: {
      id: taskId,
      project: { userId },
      OR: [
        { executionHost: null },
        { executionHost: { not: normalizedHost } },
      ],
    },
    data: { executionHost: normalizedHost },
  });
}

// States a task does not move out of on its own. Deliberately excludes
// `killing`, which is a transition *into* one of these.
const TERMINAL_TASK_STATUSES = new Set(["completed", "killed"]);

// How long a fire's websocket must have been gone before its supervising
// daemon may speak for it. Comfortably longer than the SDK's ~10s reconnect
// backoff, and well under the tmux reaper's ~30s detection latency, so it
// filters flaps without delaying a real death report.
const FIRE_DISCONNECT_SETTLE_MS = 15_000;

const getAssignedTaskHost = (task: TaskOwnershipRecord): string | null =>
  normalizeOptionalString(task.executionHost) || normalizeOptionalString(task.agentHost);

const canFireHostClaimTask = (
  task: TaskOwnershipRecord,
  agentHost: string,
  options: { allowFireHostClaim?: boolean } = {},
): boolean => {
  if (options.allowFireHostClaim === false) {
    return false;
  }
  const daemonHost = normalizeOptionalString(task.agentHost);
  return (
    isConductorFireHost(agentHost) &&
    normalizeOptionalString(task.taskType) === "ai_task" &&
    Boolean(daemonHost) &&
    !isConductorFireHost(daemonHost)
  );
};

async function ensureAgentOwnsTaskRecord(
  userId: string,
  task: TaskOwnershipRecord,
  agentHost: string,
  options: { allowFireHostClaim?: boolean; allowOwningDaemonTerminalReport?: boolean } = {},
): Promise<void> {
  const assignedHost = getAssignedTaskHost(task);
  if (!assignedHost) {
    throw new Error(`Task ${task.id} has no assigned agent host`);
  }
  const allowFireHostClaim = assignedHost !== agentHost && canFireHostClaimTask(task, agentHost, options);

  // A fire announces itself with its own host id and takes over
  // `executionHost`, so for the whole life of a healthy task the assigned
  // host is the *fire*, not the daemon that spawned it. When that fire dies
  // without reporting (crash, OOM, SIGKILL), the only witness left is its
  // supervising daemon — and the check below would reject it for not being
  // the fire, which is precisely the host that no longer exists. The task
  // then sits at `running` until reconcile relabels it `user_stopped`: the
  // exact bug the daemon-side death detection exists to fix.
  //
  // So: let the *owning* daemon (`task.agentHost`) publish a terminal status
  // on behalf of a fire host that is no longer connected. Deliberately
  // narrow — it does not apply while the fire is live (a live fire reports
  // for itself), it does not apply to non-terminal statuses (no resurrecting
  // or stealing a running task), and it does not rebind execution: we are
  // recording a death, not claiming the work.
  //
  // `hasAgentHost` is a point-in-time check, and a fire's websocket can drop
  // without the fire dying (reconnect backoff is ~10s, and a duplicate-host
  // takeover force-closes the old socket). Inside that window a live,
  // mid-turn fire is invisible, and a terminal report landing then would not
  // just mislabel the task: `commitSdkMessage` subsequently drops the live
  // fire's output and sends it `stop_task`, and `fire_exit` is not a
  // reclaimable reason, so the session is lost rather than recovered.
  //
  // So require the disconnect to be more than a flap old, mirroring how
  // `stale-recovery` gates the same signal. A null timestamp means this
  // instance never saw the socket (fresh boot, or another instance holds it)
  // — treat that as "no evidence of a recent flap" and allow, because the
  // daemon reports a death exactly once and refusing here would lose it
  // permanently, reinstating the very hang this exists to fix.
  const fireDisconnectAt =
    typeof realtimeHub.getAgentDisconnectAt === "function"
      ? realtimeHub.getAgentDisconnectAt(assignedHost, userId)
      : null;
  const fireGoneLongerThanAFlap =
    typeof fireDisconnectAt !== "number" ||
    Date.now() - fireDisconnectAt >= FIRE_DISCONNECT_SETTLE_MS;

  const owningDaemonMayReportDeath =
    options.allowOwningDaemonTerminalReport === true &&
    assignedHost !== agentHost &&
    normalizeOptionalString(task.agentHost) === agentHost &&
    isConductorFireHost(assignedHost) &&
    !isConductorFireHost(agentHost) &&
    !realtimeHub.hasAgentHost(assignedHost, userId) &&
    fireGoneLongerThanAFlap;
  if (owningDaemonMayReportDeath) {
    return;
  }

  if (!allowFireHostClaim && assignedHost !== agentHost) {
    throw new Error(`Task ${task.id} is assigned to ${assignedHost}, not ${agentHost}`);
  }

  const boundHost = realtimeHub.getTaskAgentHost(task.id);
  if (boundHost && boundHost !== agentHost && realtimeHub.hasAgentHost(boundHost, userId)) {
    const allowFireHostRebind =
      isConductorFireHost(agentHost) &&
      assignedHost === agentHost &&
      !isConductorFireHost(boundHost);
    if ((allowFireHostClaim || allowFireHostRebind) && !isConductorFireHost(boundHost)) {
      realtimeHub.bindTaskToAgent(task.id, agentHost, userId);
      await persistTaskExecutionHost(userId, task.id, agentHost);
      return;
    }
    const ownerKind = isConductorFireHost(boundHost) ? "fire host" : "agent host";
    throw new Error(`Task ${task.id} is already handled by active ${ownerKind} ${boundHost}`);
  }

  realtimeHub.bindTaskToAgent(task.id, agentHost, userId);
  await persistTaskExecutionHost(userId, task.id, agentHost);
}

async function ensureAgentOwnsTask(
  userId: string,
  taskId: string,
  agentHost: string,
  options: { allowFireHostClaim?: boolean } = {},
): Promise<void> {
  let task: TaskOwnershipRecord | null;
  try {
    task = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
      select: {
        id: true,
        agentHost: true,
        executionHost: true,
        taskType: true,
      },
    });
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) throw error;
    const partial = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
      select: {
        id: true,
        agentHost: true,
        executionHost: true,
      },
    });
    task = partial ? { ...partial, taskType: null } : null;
  }
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  await ensureAgentOwnsTaskRecord(userId, task, agentHost, options);
}

// Fetch the task row (with the legacy-schema fallback) WITHOUT enforcing
// ownership. Ownership enforcement (ensureAgentOwnsTaskRecord) mutates routing
// state — it re-binds the task to the calling host and rewrites executionHost —
// so callers that must inspect the row before deciding whether that mutation is
// appropriate (e.g. the killed-task guard) fetch first and validate later.
async function fetchOwnedTaskRecord(userId: string, taskId: string) {
  let task;
  try {
    task = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
    });
  } catch (error) {
    if (!isMissingAnyNewSchemaError(error)) throw error;
    const partial = await db.task.findFirst({
      where: { id: taskId, project: { userId } },
      select: { ...taskSelectWithoutIssueId },
    });
    task = partial ? { ...partial, issueId: null } : null;
  }
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

async function getOwnedTask(
  userId: string,
  taskId: string,
  agentHost: string,
  options: { allowOwningDaemonTerminalReport?: boolean } = {},
) {
  const task = await fetchOwnedTaskRecord(userId, taskId);
  await ensureAgentOwnsTaskRecord(userId, task, agentHost, options);
  return task;
}

type AgentCommandAckRow = {
  taskId: string | null;
  agentHost: string | null;
  eventType: string | null;
};

const isTaskNotFoundError = (error: unknown, taskId: string): boolean =>
  error instanceof Error && error.message === `Task ${taskId} not found`;

async function findAgentCommandAckRow(input: {
  userId: string;
  requestId: string;
}): Promise<AgentCommandAckRow | null> {
  try {
    return await db.agentOutbox.findFirst({
      where: {
        userId: input.userId,
        requestId: input.requestId,
      },
      select: {
        taskId: true,
        agentHost: true,
        eventType: true,
      },
    });
  } catch (error) {
    if (isMissingAgentOutboxTableError(error)) {
      return null;
    }
    throw error;
  }
}

const matchesCommandAckRow = (
  row: AgentCommandAckRow | null,
  input: {
    agentHost: string;
    taskId: string;
    eventType: string | null;
  },
): boolean => {
  if (!row) return false;
  const rowTaskId = normalizeOptionalString(row.taskId);
  const rowAgentHost = normalizeOptionalString(row.agentHost);
  const rowEventType = normalizeOptionalString(row.eventType);

  if (rowTaskId && rowTaskId !== input.taskId) return false;
  if (rowAgentHost && rowAgentHost !== input.agentHost) return false;
  if (rowEventType && input.eventType && rowEventType !== input.eventType) return false;
  return Boolean(rowTaskId);
};

export async function commitSdkMessage(input: {
  userId: string;
  agentHost: string;
  taskId: string;
  content: string;
  metadata?: Record<string, unknown>;
  messageId?: string | null;
}): Promise<{
  taskId: string;
  projectId: string;
  messageId: string | null;
  duplicate: boolean;
  dropped?: boolean;
}> {
  // Fetch the row WITHOUT enforcing ownership yet: ensureAgentOwnsTaskRecord
  // re-binds the task and rewrites executionHost, which must not happen for an
  // already-dead task.
  const task = await fetchOwnedTaskRecord(input.userId, input.taskId);

  // Achieved (packed) guard: the task was packed — its runtime is torn down and
  // its transcript is frozen at pack time. A late SDK stream (e.g. a fire that
  // was mid-resume when the task was packed) must NOT append to the frozen
  // transcript or resurrect the task. Drop it and stop the zombie backend.
  if ((task as { achievedAt?: Date | null }).achievedAt) {
    await stopKilledTaskBackend({
      userId: input.userId,
      agentHost: input.agentHost,
      taskId: task.id,
      projectId: task.projectId,
    });
    return {
      taskId: task.id,
      projectId: task.projectId,
      messageId: normalizeOptionalString(input.messageId),
      duplicate: true,
      dropped: true,
    };
  }

  // Split-brain guard: the task is already terminal (`killed`) yet this host is
  // still streaming SDK output — the backend session was never actually stopped
  // (a defensive `daemon_disconnected` kill only touches the DB, or a
  // `stop_task` never reached a since-reconnected fire). Do NOT resurrect a dead
  // task by appending messages or re-binding it. Drop the message and durably
  // stop the zombie backend (covers both the ws and the stateless HTTP ingest
  // path). Failures never block the drop.
  if (normalizeTaskStatus(task.status) === "killed") {
    await stopKilledTaskBackend({
      userId: input.userId,
      agentHost: input.agentHost,
      taskId: task.id,
      projectId: task.projectId,
    });
    return {
      taskId: task.id,
      projectId: task.projectId,
      messageId: normalizeOptionalString(input.messageId),
      duplicate: true,
      dropped: true,
    };
  }

  await ensureAgentOwnsTaskRecord(input.userId, task, input.agentHost);
  await drainAgentOutboxForHost(input.userId, input.agentHost);

  const normalizedAgentHost = normalizeOptionalString(input.agentHost);
  const shouldPromoteInitTask = normalizeTaskStatus(task.status) === "init";

  const clientMessageId = normalizeOptionalString(input.messageId);
  let message: { id: string; createdAt: Date };
  let duplicate = false;

  if (clientMessageId) {
    const existingMessage = await db.message.findUnique({
      where: { clientMessageId },
      select: { id: true, createdAt: true },
    });
    if (existingMessage) {
      message = existingMessage;
      duplicate = true;
    } else {
      try {
        [message] = await db.$transaction([
          db.message.create({
            data: {
              taskId: task.id,
              role: "sdk",
              content: input.content,
              metadata: input.metadata ? JSON.stringify(input.metadata) : null,
              clientMessageId,
            },
            select: { id: true, createdAt: true },
          }),
          db.task.update({
            where: { id: task.id },
            data: {
              updatedAt: new Date(),
              ...(shouldPromoteInitTask ? { status: "running" } : {}),
              ...(shouldPromoteInitTask && normalizedAgentHost
                ? { executionHost: normalizedAgentHost }
                : {}),
            },
          }),
        ]);
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const created = await db.message.findUnique({
            where: { clientMessageId },
            select: { id: true, createdAt: true },
          });
          if (!created) {
            throw error;
          }
          message = created;
          duplicate = true;
        } else {
          throw error;
        }
      }
    }
  } else {
    [message] = await db.$transaction([
      db.message.create({
        data: {
          taskId: task.id,
          role: "sdk",
          content: input.content,
          metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        },
        select: { id: true, createdAt: true },
      }),
      db.task.update({
        where: { id: task.id },
        data: {
          updatedAt: new Date(),
          ...(shouldPromoteInitTask ? { status: "running" } : {}),
          ...(shouldPromoteInitTask && normalizedAgentHost
            ? { executionHost: normalizedAgentHost }
            : {}),
        },
      }),
    ]);
  }

  if (!duplicate) {
    if (shouldPromoteInitTask) {
      await projectTaskStatusUpdate({
        userId: input.userId,
        projectId: task.projectId,
        taskId: task.id,
        status: "running",
      });
    }
    await projectTaskMessage({
      userId: input.userId,
      projectId: task.projectId,
      message: {
        id: message.id,
        taskId: task.id,
        role: "sdk",
        content: input.content,
        createdAt: message.createdAt,
        metadata: normalizeMessageMetadata(input.metadata),
      },
    });
  }

  return {
    taskId: task.id,
    projectId: task.projectId,
    messageId: clientMessageId,
    duplicate,
  };
}

export async function commitTaskStatusUpdate(input: {
  userId: string;
  agentHost: string;
  taskId: string;
  status: string;
  summary?: string | null;
  statusEventId?: string | null;
}): Promise<{ taskId: string; projectId: string; status: string; duplicate: boolean }> {
  // Normalize before the ownership check: whether a daemon may speak for a
  // dead fire depends on the status being terminal.
  const incomingStatus = normalizeTaskStatus(input.status);
  // Achieved (packed) guard: fetch WITHOUT enforcing ownership first, so a late
  // daemon status report can't rebind or resurrect a packed task. A packed task
  // is torn down and hidden; its status must stay frozen (otherwise a stray
  // "running" report re-breaks the terminal invariant and blocks in-place
  // un-pack). Drop the report and stop the zombie backend.
  const task = await fetchOwnedTaskRecord(input.userId, input.taskId);
  if ((task as { achievedAt?: Date | null }).achievedAt) {
    // A non-terminal report means the supposedly torn-down backend is still
    // alive. Re-stop it. Terminal reports are harmless late confirmations;
    // sending another stop for those can create a stop/report loop.
    if (!TERMINAL_TASK_STATUSES.has(incomingStatus)) {
      await stopKilledTaskBackend({
        userId: input.userId,
        agentHost: input.agentHost,
        taskId: task.id,
        projectId: task.projectId,
      });
    }
    return {
      taskId: task.id,
      projectId: task.projectId,
      status: normalizeTaskStatus(task.status),
      duplicate: false,
    };
  }
  await ensureAgentOwnsTaskRecord(input.userId, task, input.agentHost, {
    allowOwningDaemonTerminalReport:
      incomingStatus === "killed" || incomingStatus === "completed",
  });
  await drainAgentOutboxForHost(input.userId, input.agentHost);

  const status = incomingStatus;
  const summary = normalizeOptionalString(input.summary);
  const statusEventId = normalizeOptionalString(input.statusEventId);
  const currentStatus = normalizeTaskStatus(task.status);
  if (currentStatus === "killing" && status !== "completed" && status !== "killed") {
    return {
      taskId: task.id,
      projectId: task.projectId,
      status: currentStatus,
      duplicate: false,
    };
  }

  // A task that already finished successfully cannot later be killed. Two
  // producers race to report the end of one task: the fire reports its own
  // terminal status over its websocket, and the daemon reports what it
  // observed of the process. The daemon's observation always arrives second
  // (it has to notice an absence — a child exit, or a vanished tmux session)
  // and it is the less informed of the two: from the outside, "finished and
  // exited" and "crashed" can look identical. Letting it win rewrites a green
  // task as `killed` with `killedReason: "fire_exit"` minutes after the user
  // watched it succeed. Reporters that pre-check the backend status still
  // need this guard — their check is inherently TOCTOU.
  //
  // The rule is symmetric: once a task has settled into one terminal state it
  // does not move to the *other* one. `killed → completed` matters as much as
  // `killed`-over-`completed`: a user presses Stop (settling the task at
  // `killed` / `user_stopped`), the fire exits 0 in response, and ~30s later
  // the tmux reaper reads that clean exit marker and reports COMPLETED. The
  // task would then read `completed` while still carrying `killedReason:
  // "user_stopped"` and `killedAt` — a self-contradictory row, since only the
  // reclaim path ever clears those. Consumers that branch on `killedReason`
  // (e.g. the restart reclaim gate) would be reading a state that never
  // happened.
  //
  // Exception: `daemon_disconnected` is the one *defensive* kill the system
  // treats as revocable — it means "we assumed the fire died". A later report
  // from that very fire is proof we were wrong, so it must still be able to
  // correct the record rather than being frozen by our own guess.
  const isTerminalOverwrite =
    TERMINAL_TASK_STATUSES.has(currentStatus) &&
    TERMINAL_TASK_STATUSES.has(status) &&
    status !== currentStatus;
  const correctsDefensiveKill =
    currentStatus === "killed" && task.killedReason === RECLAIMABLE_KILLED_REASON;
  if (isTerminalOverwrite && !correctsDefensiveKill) {
    // Log rather than drop silently. Refusing the write also discards the
    // reporter's `summary`, which is the only account of what it saw — and a
    // guard that fires when it shouldn't would otherwise be undebuggable.
    console.warn(
      `[agent-upstream] ignoring ${status} report for already-${currentStatus} task ${task.id}` +
        (summary ? `: ${summary}` : ""),
    );
    return {
      taskId: task.id,
      projectId: task.projectId,
      status: currentStatus,
      duplicate: false,
    };
  }

  // RFC 0029: decide the killed_reason discriminator when the daemon reports a
  // task transitioning into `killed`. If the previous status was `killing`,
  // the user (or an API consumer mirroring the user intent) explicitly asked
  // for the stop and we should NOT reclaim on the next restart. Any other
  // transition into `killed` means the fire/SDK side ended on its own —
  // tag it `fire_exit` (crashes are upstream of this hub event and get a
  // different label by their handler).
  const transitioningToKilled = status === "killed" && currentStatus !== "killed";
  const killedReason: KilledReason | null = transitioningToKilled
    ? currentStatus === "killing"
      ? "user_stopped"
      : "fire_exit"
    : null;
  const baseUpdateData: Record<string, unknown> = { status };
  const buildKilledUpdateData = (): Record<string, unknown> =>
    killedReason
      ? { ...baseUpdateData, ...buildKilledPatch(killedReason) }
      : baseUpdateData;

  // `taskStatusEvent` is the ONLY place `summary` is persisted, and until now
  // it was written solely on the statusEventId branch. A daemon that reported
  // a precise reason without an id (restart failures, spawn failures) had that
  // reason silently dropped: absent from the DB, from `conductor diagnose`,
  // and from the UI, leaving only a bare status flip. Synthesize an id so a
  // summary-bearing report always lands as a real status event.
  // Trivial summaries are just the status restated ("completed", "killed").
  // Synthesizing an event for those buries the SDK's informative summary in
  // `latest_status_summary` (task-diagnostics) and adds a meaningless
  // "Status changed to completed — completed" line to daily reports. They
  // carry no diagnostic value, so don't manufacture an event to hold them.
  const isTrivialSummary =
    !!summary && summary.trim().toLowerCase() === status.trim().toLowerCase();
  const effectiveStatusEventId =
    statusEventId ?? (summary && !isTrivialSummary ? randomUUID() : null);

  // Applying the status WITHOUT a status event. Used both by the no-id path
  // and as the fallback when the status-event write fails: recording the
  // transition matters more than recording its diagnostic breadcrumb.
  const applyTaskStatusWithoutEvent = async () => {
    if (transitioningToKilled) {
      await withKilledReasonFallback(
        () =>
          db.task.update({
            where: { id: task.id },
            data: buildKilledUpdateData(),
          }),
        () =>
          db.task.update({
            where: { id: task.id },
            data: baseUpdateData,
          }),
      );
      return;
    }
    await db.task.update({
      where: { id: task.id },
      data: baseUpdateData,
    });
  };

  let duplicate = false;
  if (effectiveStatusEventId) {
    // Only a client-supplied id can collide; a synthesized one never does.
    const existing = statusEventId
      ? await db.taskStatusEvent.findUnique({
          where: { statusEventId },
          select: { id: true },
        })
      : null;
    if (existing) {
      duplicate = true;
    } else {
      const runStatusEventTransaction = (taskData: Record<string, unknown>) =>
        db.$transaction([
          db.taskStatusEvent.create({
            data: {
              taskId: task.id,
              statusEventId: effectiveStatusEventId,
              status,
              summary,
            },
          }),
          db.task.update({
            where: { id: task.id },
            data: taskData,
          }),
        ]);
      try {
        if (transitioningToKilled) {
          await withKilledReasonFallback(
            () => runStatusEventTransaction(buildKilledUpdateData()),
            () => runStatusEventTransaction(baseUpdateData),
          );
        } else {
          await runStatusEventTransaction(baseUpdateData);
        }
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          duplicate = true;
        } else {
          // The status event and the task update share one transaction, so a
          // failing event write would otherwise roll the status back too and
          // rethrow — leaving a dead task stuck at `running` forever. That is
          // a real risk on instances predating the task_status_events
          // migration, and under SQLite write contention. Degrade to applying
          // the status alone: losing the breadcrumb is acceptable, losing the
          // terminal state is not.
          console.error(
            `[agent-upstream] failed to persist status event for task ${task.id}; ` +
              `applying status without it: ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
          await applyTaskStatusWithoutEvent();
        }
      }
    }
  } else {
    await applyTaskStatusWithoutEvent();
  }

  if (!duplicate) {
    await projectTaskStatusUpdate({
      userId: input.userId,
      projectId: task.projectId,
      taskId: task.id,
      status,
      summary,
    });
  }

  return {
    taskId: task.id,
    projectId: task.projectId,
    status,
    duplicate,
  };
}

export async function commitAgentCommandAck(input: {
  userId: string;
  agentHost: string;
  requestId: string;
  taskId?: string | null;
  eventType?: string | null;
  accepted?: boolean;
}): Promise<{ requestId: string; accepted: boolean; duplicate: boolean }> {
  const requestId = normalizeOptionalString(input.requestId);
  if (!requestId) {
    throw new Error("request_id is required");
  }
  const taskId = normalizeOptionalString(input.taskId);
  const eventType = normalizeOptionalString(input.eventType);
  const ackRow = taskId
    ? await findAgentCommandAckRow({
        userId: input.userId,
        requestId,
      })
    : null;
  let taskExists = true;
  if (taskId) {
    try {
      await ensureAgentOwnsTask(input.userId, taskId, input.agentHost, {
        allowFireHostClaim: eventType !== "interrupt_turn",
      });
    } catch (error) {
      if (
        !isTaskNotFoundError(error, taskId) ||
        !matchesCommandAckRow(ackRow, {
          agentHost: input.agentHost,
          taskId,
          eventType,
        })
      ) {
        throw error;
      }
      taskExists = false;
    }
  }
  const accepted = input.accepted !== false;
  if (taskId && taskExists) {
    realtimeHub.acknowledgeAgentCommand(taskId, requestId, accepted, {
      agentHost: input.agentHost,
      eventType: eventType || null,
    });
  }
  await drainAgentOutboxForHost(input.userId, input.agentHost);
  const result = await acknowledgeAgentCommand({
    userId: input.userId,
    requestId,
    accepted,
    eventType: eventType || undefined,
  });
  return {
    requestId,
    accepted,
    duplicate: result.count === 0,
  };
}

export async function commitTaskStopAck(input: {
  userId: string;
  agentHost: string;
  taskId: string;
  requestId: string;
  accepted?: boolean;
}): Promise<{ taskId: string; requestId: string; accepted: boolean; duplicate: boolean }> {
  const taskId = normalizeOptionalString(input.taskId);
  const requestId = normalizeOptionalString(input.requestId);
  if (!taskId || !requestId) {
    throw new Error("task_id and request_id are required");
  }
  await ensureAgentOwnsTask(input.userId, taskId, input.agentHost);
  const accepted = input.accepted !== false;
  realtimeHub.acknowledgeTaskStop(taskId, requestId, accepted);
  const result = await acknowledgeAgentCommand({
    userId: input.userId,
    requestId,
    accepted,
    eventType: "task_stop_ack",
  });
  return {
    taskId,
    requestId,
    accepted,
    duplicate: result.count === 0,
  };
}

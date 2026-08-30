import { appendUserMessageToTask } from "@/lib/channel/task-ingress-service";
import { db } from "@/lib/db";
import { normalizeTaskStatus } from "@/lib/tasks/task-config";

export type ScheduledMessageMode =
  | {
      mode: "delay";
      amount: number;
      unit: "minute" | "hour";
    }
  | {
      mode: "at";
      sendAt: string | Date;
      timezone?: string | null;
    }
  | {
      mode: "interval";
      every: number;
      unit: "minute" | "hour";
      condition?: "none" | "ai_idle";
      stop?: {
        maxRuns?: number | null;
        maxSkips?: number | null;
        stopAt?: string | Date | null;
        stopWhenTaskNotRunning?: boolean | null;
      } | null;
    };

export type CreateScheduledMessageInput = {
  userId: string;
  taskId: string;
  sourceMessageId?: string | null;
  content: string;
  schedule: ScheduledMessageMode;
  now?: Date;
};

export type UpdateScheduledMessageInput = {
  userId: string;
  taskId: string;
  scheduleId: string;
  content?: string | null;
  schedule?: ScheduledMessageMode | null;
  now?: Date;
};

export type ScheduledMessageResponse = {
  id: string;
  userId: string;
  taskId: string;
  sourceMessageId: string | null;
  content: string;
  kind: string;
  condition: string;
  intervalMs: number | null;
  timezone: string | null;
  status: string;
  nextRunAt: string;
  runCount: number;
  skipCount: number;
  failureCount: number;
  maxRuns: number | null;
  maxSkips: number | null;
  stopAt: string | null;
  stopWhenTaskNotRunning: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

type ScheduledMessageRow = Awaited<ReturnType<typeof db.scheduledMessage.findFirst>>;

type ClaimedScheduledMessage = NonNullable<
  Awaited<ReturnType<typeof db.scheduledMessage.findUnique>>
> & {
  task?: {
    id: string;
    projectId: string;
    status: string;
    taskType?: string | null;
    runtimeState?: {
      replyInProgress: boolean;
      updatedAt: Date;
    } | null;
  } | null;
};

type ProcessDueOptions = {
  now?: Date;
  limit?: number;
};

type ProcessDueStats = {
  scanned: number;
  claimed: number;
  sent: number;
  skipped: number;
  completed: number;
  failed: number;
};

const UNIT_MS = {
  minute: 60_000,
  hour: 60 * 60_000,
} as const;

const MAX_INT_MS = 2_147_483_647;
const DEFAULT_DISPATCHER_INTERVAL_MS = 30_000;
const DEFAULT_PROCESS_LIMIT = 50;
const SENDING_STALE_AFTER_MS = 5 * 60_000;

let dispatcherTimer: ReturnType<typeof setInterval> | null = null;
let dispatcherInFlight = false;
let warnedMissingScheduledMessagesSchema = false;

export class ScheduledMessageError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;

  constructor(code: string, status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ScheduledMessageError";
    this.code = code;
    this.status = status;
    this.details = details ?? { error: code, message };
  }
}

const normalizePositiveInteger = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ScheduledMessageError("invalid_schedule", 400, `${label} must be a positive integer`);
  }
  return value;
};

const parseDate = (value: string | Date, label: string): Date => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ScheduledMessageError("invalid_schedule", 400, `${label} must be a valid date`);
  }
  return date;
};

const dateToIsoOrNull = (value?: Date | null): string | null => (
  value ? value.toISOString() : null
);

const isMissingScheduledMessagesSchemaError = (error: unknown): boolean => {
  const code = (error as { code?: unknown })?.code;
  const message = String((error as { message?: unknown })?.message || "").toLowerCase();
  return (
    (code === "P2021" || code === "P2022") &&
    (message.includes("scheduled_messages") ||
      message.includes("scheduledmessage") ||
      message.includes("task_runtime_states") ||
      message.includes("taskruntimestate"))
  );
};

const warnMissingScheduledMessagesSchema = (context: string, error: unknown): void => {
  if (warnedMissingScheduledMessagesSchema) return;
  warnedMissingScheduledMessagesSchema = true;
  const detail = error instanceof Error ? error.message : String(error);
  console.warn(
    `[scheduled-messages] ${context}: database schema is missing scheduled message tables. Run 'pnpm -C web db:push'. (${detail})`,
  );
};

const toIntervalMs = (amount: number, unit: "minute" | "hour", label: string): number => {
  const normalizedAmount = normalizePositiveInteger(amount, label);
  const intervalMs = normalizedAmount * UNIT_MS[unit];
  if (!Number.isSafeInteger(intervalMs) || intervalMs > MAX_INT_MS) {
    throw new ScheduledMessageError(
      "invalid_schedule",
      400,
      `${label} is too large for a scheduled message`,
    );
  }
  return intervalMs;
};

const buildScheduledRunClientRequestId = (scheduleId: string, runNumber: number): string =>
  `scheduled-message:${scheduleId}:${runNumber}`;

const resolveCreateData = (
  schedule: ScheduledMessageMode,
  now: Date,
): {
  kind: "once_delay" | "once_at" | "interval";
  condition: "none" | "ai_idle";
  intervalMs: number | null;
  timezone: string | null;
  nextRunAt: Date;
  maxRuns: number | null;
  maxSkips: number | null;
  stopAt: Date | null;
  stopWhenTaskNotRunning: boolean;
} => {
  if (schedule.mode === "delay") {
    const delayMs = toIntervalMs(schedule.amount, schedule.unit, "delay");
    return {
      kind: "once_delay",
      condition: "none",
      intervalMs: null,
      timezone: null,
      nextRunAt: new Date(now.getTime() + delayMs),
      maxRuns: null,
      maxSkips: null,
      stopAt: null,
      stopWhenTaskNotRunning: true,
    };
  }

  if (schedule.mode === "at") {
    const sendAt = parseDate(schedule.sendAt, "sendAt");
    if (sendAt.getTime() <= now.getTime()) {
      throw new ScheduledMessageError("invalid_schedule", 400, "sendAt must be in the future");
    }
    return {
      kind: "once_at",
      condition: "none",
      intervalMs: null,
      timezone: schedule.timezone?.trim() || null,
      nextRunAt: sendAt,
      maxRuns: null,
      maxSkips: null,
      stopAt: null,
      stopWhenTaskNotRunning: true,
    };
  }

  const intervalMs = toIntervalMs(schedule.every, schedule.unit, "interval");
  const stopAt = schedule.stop?.stopAt ? parseDate(schedule.stop.stopAt, "stopAt") : null;
  if (stopAt && stopAt.getTime() <= now.getTime()) {
    throw new ScheduledMessageError("invalid_schedule", 400, "stopAt must be in the future");
  }
  const maxRuns =
    schedule.stop?.maxRuns == null
      ? null
      : normalizePositiveInteger(schedule.stop.maxRuns, "maxRuns");
  const maxSkips =
    schedule.stop?.maxSkips == null
      ? null
      : normalizePositiveInteger(schedule.stop.maxSkips, "maxSkips");

  return {
    kind: "interval",
    condition: schedule.condition === "ai_idle" ? "ai_idle" : "none",
    intervalMs,
    timezone: null,
    nextRunAt: new Date(now.getTime() + intervalMs),
    maxRuns,
    maxSkips,
    stopAt,
    stopWhenTaskNotRunning: schedule.stop?.stopWhenTaskNotRunning ?? true,
  };
};

export const buildScheduledMessageResponse = (
  row: NonNullable<ScheduledMessageRow>,
): ScheduledMessageResponse => ({
  id: row.id,
  userId: row.userId,
  taskId: row.taskId,
  sourceMessageId: row.sourceMessageId ?? null,
  content: row.content,
  kind: row.kind,
  condition: row.condition,
  intervalMs: row.intervalMs ?? null,
  timezone: row.timezone ?? null,
  status: row.status,
  nextRunAt: row.nextRunAt.toISOString(),
  runCount: row.runCount,
  skipCount: row.skipCount,
  failureCount: row.failureCount,
  maxRuns: row.maxRuns ?? null,
  maxSkips: row.maxSkips ?? null,
  stopAt: dateToIsoOrNull(row.stopAt),
  stopWhenTaskNotRunning: row.stopWhenTaskNotRunning,
  lastRunAt: dateToIsoOrNull(row.lastRunAt),
  lastError: row.lastError ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export async function createScheduledMessageForTask(
  input: CreateScheduledMessageInput,
): Promise<ScheduledMessageResponse> {
  const content = input.content.trim();
  if (!content) {
    throw new ScheduledMessageError("content_required", 400, "content required");
  }

  const task = await db.task.findFirst({
    where: { id: input.taskId, project: { userId: input.userId } },
    select: { id: true, taskType: true },
  });
  if (!task) {
    throw new ScheduledMessageError("not_found", 404, "Not found", { error: "Not found" });
  }
  if (task.taskType === "pty_task") {
    throw new ScheduledMessageError("task_type_not_messageable", 409, "pty_task does not accept chat messages", {
      error: "task_type_not_messageable",
      message: "pty_task does not accept chat messages",
    });
  }

  const sourceMessageId = input.sourceMessageId?.trim() || null;
  if (sourceMessageId) {
    const sourceMessage = await db.message.findFirst({
      where: {
        id: sourceMessageId,
        taskId: input.taskId,
      },
      select: { id: true },
    });
    if (!sourceMessage) {
      throw new ScheduledMessageError("source_message_not_found", 404, "Source message not found", {
        error: "source_message_not_found",
        message: "Source message not found",
      });
    }
  }

  const now = input.now ?? new Date();
  const scheduleData = resolveCreateData(input.schedule, now);
  const scheduled = await db.scheduledMessage.create({
    data: {
      userId: input.userId,
      taskId: input.taskId,
      sourceMessageId,
      content,
      kind: scheduleData.kind,
      condition: scheduleData.condition,
      intervalMs: scheduleData.intervalMs,
      timezone: scheduleData.timezone,
      nextRunAt: scheduleData.nextRunAt,
      maxRuns: scheduleData.maxRuns,
      maxSkips: scheduleData.maxSkips,
      stopAt: scheduleData.stopAt,
      stopWhenTaskNotRunning: scheduleData.stopWhenTaskNotRunning,
      metadata: JSON.stringify({
        createdBy: "message_bubble",
      }),
    },
  });

  return buildScheduledMessageResponse(scheduled);
}

export async function listScheduledMessagesForTask(input: {
  userId: string;
  taskId: string;
  /** Restrict to a single lifecycle status. `all` (or omitted) returns every row. */
  status?: string | null;
  /**
   * Substring match against the scheduled message content. Matching is
   * case-insensitive for ASCII because SQLite's LIKE is; Prisma's
   * `mode: "insensitive"` is unsupported on SQLite, so moving this schema to
   * PostgreSQL would turn the filter case-sensitive and needs that flag added.
   */
  keyword?: string | null;
}): Promise<ScheduledMessageResponse[]> {
  const task = await db.task.findFirst({
    where: { id: input.taskId, project: { userId: input.userId } },
    select: { id: true },
  });
  if (!task) {
    throw new ScheduledMessageError("not_found", 404, "Not found", { error: "Not found" });
  }
  const status = input.status?.trim();
  const keyword = input.keyword?.trim();
  const rows = await db.scheduledMessage.findMany({
    where: {
      userId: input.userId,
      taskId: input.taskId,
      ...(status && status !== "all" ? { status } : {}),
      ...(keyword ? { content: { contains: keyword } } : {}),
    },
    orderBy: [{ status: "asc" }, { nextRunAt: "asc" }],
    take: 100,
  });
  return rows.map(buildScheduledMessageResponse);
}

/**
 * Edits an already-scheduled message. Only `active` rows are editable: a row
 * the dispatcher already claimed (`sending`) or finished must not be rewritten
 * underneath it, so the status guard lives in the same `updateMany` that writes
 * the new values.
 */
export async function updateScheduledMessageForTask(
  input: UpdateScheduledMessageInput,
): Promise<ScheduledMessageResponse | null> {
  const existing = await db.scheduledMessage.findFirst({
    where: { id: input.scheduleId, userId: input.userId, taskId: input.taskId },
    select: { id: true, status: true },
  });
  if (!existing) {
    return null;
  }

  const data: Record<string, unknown> = {};

  if (input.content != null) {
    const content = input.content.trim();
    if (!content) {
      throw new ScheduledMessageError("content_required", 400, "content required");
    }
    data.content = content;
  }

  if (input.schedule) {
    const scheduleData = resolveCreateData(input.schedule, input.now ?? new Date());
    data.kind = scheduleData.kind;
    data.condition = scheduleData.condition;
    data.intervalMs = scheduleData.intervalMs;
    data.timezone = scheduleData.timezone;
    data.nextRunAt = scheduleData.nextRunAt;
    data.maxRuns = scheduleData.maxRuns;
    data.maxSkips = scheduleData.maxSkips;
    data.stopAt = scheduleData.stopAt;
    data.stopWhenTaskNotRunning = scheduleData.stopWhenTaskNotRunning;
    // A rescheduled row starts over from the new plan, so stale run bookkeeping
    // would otherwise trip the maxRuns/maxSkips stop conditions immediately.
    data.runCount = 0;
    data.skipCount = 0;
    data.failureCount = 0;
    data.lastError = null;
  }

  if (Object.keys(data).length === 0) {
    throw new ScheduledMessageError("invalid_request", 400, "Nothing to update");
  }

  const updated = await db.scheduledMessage.updateMany({
    where: {
      id: input.scheduleId,
      userId: input.userId,
      taskId: input.taskId,
      status: "active",
    },
    data,
  });
  if (updated.count === 0) {
    throw new ScheduledMessageError(
      "schedule_not_editable",
      409,
      "Only active scheduled messages can be edited",
    );
  }

  const row = await db.scheduledMessage.findUnique({ where: { id: input.scheduleId } });
  return row ? buildScheduledMessageResponse(row) : null;
}

/**
 * Current status of one row, or null when it does not exist. Lets a failed
 * remove tell "the dispatcher is mid-send" apart from "already gone" instead of
 * reporting both as a 404.
 */
export async function getScheduledMessageStatusForTask(input: {
  userId: string;
  taskId: string;
  scheduleId: string;
}): Promise<string | null> {
  const row = await db.scheduledMessage.findFirst({
    where: { id: input.scheduleId, userId: input.userId, taskId: input.taskId },
    select: { status: true },
  });
  return row?.status ?? null;
}

/**
 * Removes a finished row (completed/canceled/failed/sent) from history. Active
 * and in-flight (`sending`) rows are never hard-deleted -- those go through
 * `cancelScheduledMessageForTask` so the dispatcher keeps a consistent view.
 */
export async function deleteScheduledMessageForTask(input: {
  userId: string;
  taskId: string;
  scheduleId: string;
}): Promise<boolean> {
  const result = await db.scheduledMessage.deleteMany({
    where: {
      id: input.scheduleId,
      userId: input.userId,
      taskId: input.taskId,
      status: { notIn: ["active", "sending"] },
    },
  });
  return result.count > 0;
}

export async function cancelScheduledMessageForTask(input: {
  userId: string;
  taskId: string;
  scheduleId: string;
}): Promise<boolean> {
  const result = await db.scheduledMessage.updateMany({
    where: {
      id: input.scheduleId,
      userId: input.userId,
      taskId: input.taskId,
      status: "active",
    },
    data: {
      status: "canceled",
      updatedAt: new Date(),
    },
  });
  return result.count > 0;
}

const getScheduledMessageModel = () =>
  (db as typeof db & {
    scheduledMessage?: typeof db.scheduledMessage;
  }).scheduledMessage ?? null;

export async function countActiveScheduledMessagesForTasks(input: {
  userId: string;
  taskIds: string[];
}): Promise<Map<string, number>> {
  const taskIds = [...new Set(input.taskIds.map((id) => id.trim()).filter(Boolean))];
  const counts = new Map<string, number>(taskIds.map((id) => [id, 0]));
  if (taskIds.length === 0) {
    return counts;
  }

  const scheduledMessage = getScheduledMessageModel();
  if (!scheduledMessage?.findMany) {
    return counts;
  }

  try {
    const rows = await scheduledMessage.findMany({
      where: {
        userId: input.userId,
        taskId: { in: taskIds },
        status: "active",
      },
      select: {
        taskId: true,
      },
    });
    for (const row of rows) {
      counts.set(row.taskId, (counts.get(row.taskId) ?? 0) + 1);
    }
  } catch (error) {
    if (!isMissingScheduledMessagesSchemaError(error)) {
      throw error;
    }
    warnMissingScheduledMessagesSchema("countActiveScheduledMessagesForTasks", error);
  }

  return counts;
}

export async function countActiveScheduledMessagesForProjects(input: {
  userId: string;
  projectIds?: string[] | null;
}): Promise<Map<string, number>> {
  const projectIds = input.projectIds
    ? [...new Set(input.projectIds.map((id) => id.trim()).filter(Boolean))]
    : null;
  const counts = new Map<string, number>((projectIds ?? []).map((id) => [id, 0]));

  const scheduledMessage = getScheduledMessageModel();
  if (!scheduledMessage?.findMany) {
    return counts;
  }

  try {
    const rows = await scheduledMessage.findMany({
      where: {
        userId: input.userId,
        status: "active",
        ...(projectIds
          ? {
              task: {
                projectId: { in: projectIds },
              },
            }
          : {}),
      },
      select: {
        task: {
          select: {
            projectId: true,
          },
        },
      },
    });
    for (const row of rows) {
      const projectId = row.task?.projectId;
      if (!projectId) {
        continue;
      }
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
  } catch (error) {
    if (!isMissingScheduledMessagesSchemaError(error)) {
      throw error;
    }
    warnMissingScheduledMessagesSchema("countActiveScheduledMessagesForProjects", error);
  }

  return counts;
}

function nextIntervalRunAt(scheduled: Pick<ClaimedScheduledMessage, "intervalMs">, now: Date): Date | null {
  if (!scheduled.intervalMs || scheduled.intervalMs <= 0) {
    return null;
  }
  return new Date(now.getTime() + scheduled.intervalMs);
}

async function completeScheduledMessage(
  id: string,
  now: Date,
  lastError?: string | null,
): Promise<"completed"> {
  await db.scheduledMessage.update({
    where: { id },
    data: {
      status: "completed",
      lastRunAt: now,
      lastError: lastError ?? null,
    },
  });
  return "completed";
}

async function failScheduledMessage(
  scheduled: ClaimedScheduledMessage,
  now: Date,
  message: string,
): Promise<"failed" | "skipped"> {
  const failureCount = scheduled.failureCount + 1;
  if (scheduled.kind !== "interval") {
    await db.scheduledMessage.update({
      where: { id: scheduled.id },
      data: {
        status: "failed",
        failureCount,
        lastRunAt: now,
        lastError: message,
      },
    });
    return "failed";
  }

  const nextRunAt = nextIntervalRunAt(scheduled, now);
  if (!nextRunAt || (scheduled.stopAt && nextRunAt.getTime() > scheduled.stopAt.getTime())) {
    await completeScheduledMessage(scheduled.id, now, message);
    return "skipped";
  }

  await db.scheduledMessage.update({
    where: { id: scheduled.id },
    data: {
      status: "active",
      failureCount,
      nextRunAt,
      lastRunAt: now,
      lastError: message,
    },
  });
  return "skipped";
}

async function markUnexpectedExecutionError(
  scheduled: Pick<
    ClaimedScheduledMessage,
    "id" | "kind" | "intervalMs" | "nextRunAt" | "failureCount" | "stopAt"
  >,
  now: Date,
  error: unknown,
): Promise<"failed" | "skipped" | "completed"> {
  const message = error instanceof Error ? error.message : String(error);
  const failureCount = scheduled.failureCount + 1;
  if (scheduled.kind !== "interval") {
    await db.scheduledMessage.update({
      where: { id: scheduled.id },
      data: {
        status: "failed",
        failureCount,
        lastRunAt: now,
        lastError: message,
      },
    });
    return "failed";
  }

  const nextRunAt = nextIntervalRunAt(scheduled, now);
  if (!nextRunAt || (scheduled.stopAt && nextRunAt.getTime() > scheduled.stopAt.getTime())) {
    await db.scheduledMessage.update({
      where: { id: scheduled.id },
      data: {
        status: "completed",
        failureCount,
        lastRunAt: now,
        lastError: message,
      },
    });
    return "completed";
  }

  await db.scheduledMessage.update({
    where: { id: scheduled.id },
    data: {
      status: "active",
      failureCount,
      nextRunAt,
      lastRunAt: now,
      lastError: message,
    },
  });
  return "skipped";
}

async function skipScheduledMessage(
  scheduled: ClaimedScheduledMessage,
  now: Date,
  reason: string,
): Promise<"skipped" | "completed"> {
  const skipCount = scheduled.skipCount + 1;
  const shouldStopForSkips = scheduled.maxSkips != null && skipCount >= scheduled.maxSkips;
  const nextRunAt = nextIntervalRunAt(scheduled, now);
  if (
    scheduled.kind !== "interval" ||
    shouldStopForSkips ||
    !nextRunAt ||
    (scheduled.stopAt && nextRunAt.getTime() > scheduled.stopAt.getTime())
  ) {
    await db.scheduledMessage.update({
      where: { id: scheduled.id },
      data: {
        status: "completed",
        skipCount,
        lastRunAt: now,
        lastError: reason,
      },
    });
    return "completed";
  }

  await db.scheduledMessage.update({
    where: { id: scheduled.id },
    data: {
      status: "active",
      skipCount,
      nextRunAt,
      lastRunAt: now,
      lastError: reason,
    },
  });
  return "skipped";
}

async function finishSuccessfulScheduledMessage(
  scheduled: ClaimedScheduledMessage,
  now: Date,
): Promise<"sent" | "completed"> {
  const runCount = scheduled.runCount + 1;
  const shouldStopForRuns = scheduled.maxRuns != null && runCount >= scheduled.maxRuns;
  const nextRunAt = nextIntervalRunAt(scheduled, now);
  const shouldComplete =
    scheduled.kind !== "interval" ||
    shouldStopForRuns ||
    !nextRunAt ||
    (scheduled.stopAt && nextRunAt.getTime() > scheduled.stopAt.getTime());

  await db.scheduledMessage.update({
    where: { id: scheduled.id },
    data: {
      status: shouldComplete ? (scheduled.kind === "interval" ? "completed" : "sent") : "active",
      runCount,
      nextRunAt: shouldComplete ? scheduled.nextRunAt : nextRunAt,
      lastRunAt: now,
      lastError: null,
    },
  });

  return shouldComplete ? (scheduled.kind === "interval" ? "completed" : "sent") : "sent";
}

async function executeClaimedScheduledMessage(
  scheduleId: string,
  now: Date,
): Promise<"sent" | "skipped" | "completed" | "failed"> {
  const scheduled = (await db.scheduledMessage.findUnique({
    where: { id: scheduleId },
    include: {
      task: {
        select: {
          id: true,
          projectId: true,
          status: true,
          taskType: true,
          runtimeState: {
            select: {
              replyInProgress: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  })) as ClaimedScheduledMessage | null;

  if (!scheduled?.task) {
    await completeScheduledMessage(scheduleId, now, "task_not_found");
    return "completed";
  }

  if (scheduled.stopAt && now.getTime() > scheduled.stopAt.getTime()) {
    return completeScheduledMessage(scheduled.id, now, "stop_at_reached");
  }

  if (scheduled.task.taskType === "pty_task") {
    return failScheduledMessage(scheduled, now, "task_type_not_messageable");
  }

  const taskStatus = normalizeTaskStatus(scheduled.task.status);
  if (taskStatus !== "running") {
    if (scheduled.stopWhenTaskNotRunning || scheduled.kind !== "interval") {
      return completeScheduledMessage(scheduled.id, now, "task_not_running");
    }
    return skipScheduledMessage(scheduled, now, "task_not_running");
  }

  if (scheduled.condition === "ai_idle") {
    if (!scheduled.task.runtimeState) {
      return skipScheduledMessage(scheduled, now, "runtime_state_unavailable");
    }
    if (scheduled.task.runtimeState.replyInProgress) {
      return skipScheduledMessage(scheduled, now, "ai_reply_in_progress");
    }
  }

  try {
    const scheduledRun = scheduled.runCount + 1;
    const clientRequestId = buildScheduledRunClientRequestId(scheduled.id, scheduledRun);
    await appendUserMessageToTask({
      userId: scheduled.userId,
      taskId: scheduled.taskId,
      role: "user",
      content: scheduled.content,
      clientMessageId: clientRequestId,
      metadata: {
        scheduledMessageId: scheduled.id,
        scheduledRun,
        clientRequestId,
        sourceMessageId: scheduled.sourceMessageId ?? undefined,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failScheduledMessage(scheduled, now, message);
  }

  return finishSuccessfulScheduledMessage(scheduled, now);
}

export async function processDueScheduledMessages(
  options: ProcessDueOptions = {},
): Promise<ProcessDueStats> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_PROCESS_LIMIT;
  const stats: ProcessDueStats = {
    scanned: 0,
    claimed: 0,
    sent: 0,
    skipped: 0,
    completed: 0,
    failed: 0,
  };

  try {
    await db.scheduledMessage.updateMany({
      where: {
        status: "sending",
        updatedAt: { lte: new Date(now.getTime() - SENDING_STALE_AFTER_MS) },
      },
      data: {
        status: "active",
        nextRunAt: now,
        lastError: "sending_timeout",
        updatedAt: now,
      },
    });

    const dueRows = await db.scheduledMessage.findMany({
      where: {
        status: "active",
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: "asc" },
      take: limit,
    });
    stats.scanned = dueRows.length;

    for (const dueRow of dueRows) {
      const claimed = await db.scheduledMessage.updateMany({
        where: {
          id: dueRow.id,
          status: "active",
          nextRunAt: { lte: now },
        },
        data: {
          status: "sending",
          updatedAt: now,
        },
      });
      if (claimed.count === 0) {
        continue;
      }

      stats.claimed += 1;
      let result: "sent" | "skipped" | "completed" | "failed";
      try {
        result = await executeClaimedScheduledMessage(dueRow.id, now);
      } catch (error) {
        result = await markUnexpectedExecutionError(dueRow, now, error);
      }
      if (result === "sent") stats.sent += 1;
      if (result === "skipped") stats.skipped += 1;
      if (result === "completed") stats.completed += 1;
      if (result === "failed") stats.failed += 1;
    }
  } catch (error) {
    if (isMissingScheduledMessagesSchemaError(error)) {
      warnMissingScheduledMessagesSchema("process_due", error);
      return stats;
    }
    throw error;
  }

  return stats;
}

export async function persistTaskRuntimeState(input: {
  taskId: string;
  projectId?: string | null;
  state?: unknown;
  phase?: unknown;
  source?: unknown;
  replyInProgress?: unknown;
  statusLine?: unknown;
  statusDoneLine?: unknown;
  replyPreview?: unknown;
  replyTo?: unknown;
  backend?: unknown;
  sessionId?: unknown;
}): Promise<void> {
  const model = (db as unknown as {
    taskRuntimeState?: {
      upsert?: (args: unknown) => Promise<unknown>;
    };
  }).taskRuntimeState;
  if (!model?.upsert) {
    return;
  }

  const data = {
    projectId: input.projectId ?? null,
    state: typeof input.state === "string" ? input.state : null,
    phase: typeof input.phase === "string" ? input.phase : null,
    source: typeof input.source === "string" ? input.source : null,
    replyInProgress: Boolean(input.replyInProgress),
    statusLine: typeof input.statusLine === "string" ? input.statusLine : null,
    statusDoneLine: typeof input.statusDoneLine === "string" ? input.statusDoneLine : null,
    replyPreview: typeof input.replyPreview === "string" ? input.replyPreview : null,
    replyTo: typeof input.replyTo === "string" ? input.replyTo : null,
    backend: typeof input.backend === "string" ? input.backend : null,
    sessionId: typeof input.sessionId === "string" ? input.sessionId : null,
  };

  try {
    await model.upsert({
      where: { taskId: input.taskId },
      create: {
        taskId: input.taskId,
        ...data,
      },
      update: data,
    });
  } catch (error) {
    if (isMissingScheduledMessagesSchemaError(error)) {
      warnMissingScheduledMessagesSchema("persist_runtime", error);
      return;
    }
    console.warn(
      `[scheduled-messages] failed to persist task runtime state for ${input.taskId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function startScheduledMessageDispatcher(options: {
  intervalMs?: number;
  limit?: number;
} = {}): () => void {
  if (dispatcherTimer) {
    return () => {};
  }

  const intervalMs = options.intervalMs ?? DEFAULT_DISPATCHER_INTERVAL_MS;
  const limit = options.limit ?? DEFAULT_PROCESS_LIMIT;
  const tick = () => {
    if (dispatcherInFlight) {
      return;
    }
    dispatcherInFlight = true;
    void processDueScheduledMessages({ limit })
      .catch((error) => {
        console.error(
          `[scheduled-messages] dispatcher tick failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        dispatcherInFlight = false;
      });
  };

  dispatcherTimer = setInterval(tick, intervalMs);
  tick();

  return () => {
    if (dispatcherTimer) {
      clearInterval(dispatcherTimer);
      dispatcherTimer = null;
    }
  };
}

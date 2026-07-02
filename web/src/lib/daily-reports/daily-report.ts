import { db } from "@/lib/db";
import { realtimeHub } from "@/lib/realtime/hub";
import { summarizeDailyReportWithGlm } from "./glm-summarizer";

export type DailyReportDeliveryChannel = "in_app" | "feishu";

export type DailyReportSettingResponse = {
  enabled: boolean;
  timezone: string;
  sendTimeLocal: string;
  send_time_local: string;
  deliveryChannels: DailyReportDeliveryChannel[];
  delivery_channels: DailyReportDeliveryChannel[];
  nextRunAt: string | null;
  next_run_at: string | null;
  lastSentForDate: string | null;
  last_sent_for_date: string | null;
  lastRunAt: string | null;
  last_run_at: string | null;
  lastError: string | null;
  last_error: string | null;
};

export type DailyReportEvent = {
  type: "task_created" | "message" | "status" | "task_closed" | "task_updated";
  timestamp: string;
  time: string;
  title: string;
  detail: string | null;
  role?: string | null;
  status?: string | null;
};

export type DailyReportTaskSegment = {
  taskId: string;
  task_id: string;
  taskTitle: string;
  task_title: string;
  issueTitle: string | null;
  issue_title: string | null;
  status: string;
  startAt: string;
  start_at: string;
  endAt: string | null;
  end_at: string | null;
  timeRange: string;
  time_range: string;
  summary: string;
  events: DailyReportEvent[];
};

export type DailyReportProject = {
  projectId: string;
  project_id: string;
  projectName: string;
  project_name: string;
  daemonHost: string | null;
  daemon_host: string | null;
  summary: string;
  stats: {
    tasksTouched: number;
    tasks_touched: number;
    messages: number;
    completed: number;
    running: number;
    killed: number;
  };
  timeline: DailyReportTaskSegment[];
};

export type DailyReportSummarizerMetadata = {
  provider: "rules" | "glm";
  model: string | null;
  status: "not_requested" | "disabled" | "missing_api_key" | "success" | "fallback";
  generatedAt: string;
  generated_at: string;
  error: string | null;
};

export type DailyReportPayload = {
  reportDate: string;
  report_date: string;
  timezone: string;
  generatedAt: string;
  generated_at: string;
  rangeStart: string;
  range_start: string;
  rangeEnd: string;
  range_end: string;
  totals: {
    projects: number;
    tasks: number;
    messages: number;
    completed: number;
    running: number;
    killed: number;
  };
  projects: DailyReportProject[];
  summarizer?: DailyReportSummarizerMetadata;
};

export type DailyReportResponse = {
  id: string | null;
  userId: string;
  user_id: string;
  reportDate: string;
  report_date: string;
  timezone: string;
  status: string;
  summaryMarkdown: string;
  summary_markdown: string;
  payload: DailyReportPayload;
  deliveryChannels: DailyReportDeliveryChannel[];
  delivery_channels: DailyReportDeliveryChannel[];
  sentAt: string | null;
  sent_at: string | null;
  lastError: string | null;
  last_error: string | null;
  persisted: boolean;
  createdAt: string | null;
  created_at: string | null;
  updatedAt: string | null;
  updated_at: string | null;
};

type DailyReportSettingRow = {
  id: string;
  userId: string;
  enabled: boolean;
  timezone: string;
  sendTimeLocal: string;
  deliveryChannels: string;
  nextRunAt: Date | null;
  lastSentForDate: string | null;
  lastRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type DailyReportRunRow = {
  id: string;
  userId: string;
  reportDate: string;
  timezone: string;
  status: string;
  summaryMarkdown: string;
  payloadJson: string;
  deliveryChannels: string;
  sentAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReportTaskRow = {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  killedAt?: Date | null;
  project: {
    id: string;
    name: string;
    daemonHost?: string | null;
  };
  issue?: {
    title: string;
  } | null;
  messages?: Array<{
    id: string;
    role: string;
    content: string;
    createdAt: Date;
  }>;
  taskStatusEvents?: Array<{
    id: string;
    status: string;
    summary?: string | null;
    createdAt: Date;
  }>;
};

const DEFAULT_TIMEZONE = "Asia/Shanghai";
const DEFAULT_SEND_TIME_LOCAL = "20:00";
const DEFAULT_DELIVERY_CHANNELS: DailyReportDeliveryChannel[] = ["in_app"];
const DEFAULT_DISPATCHER_INTERVAL_MS = 60_000;
const DEFAULT_PROCESS_LIMIT = 20;
const DEFAULT_RECONCILE_LIMIT = 5_000;
const SEND_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

let dispatcherTimer: ReturnType<typeof setInterval> | null = null;
let dispatcherInFlight = false;
let warnedMissingDailyReportSchema = false;

export class DailyReportSchemaUnavailableError extends Error {
  constructor() {
    super("Daily reports are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.");
    this.name = "DailyReportSchemaUnavailableError";
  }
}

export class DailyReportInputError extends Error {
  status: number;
  details: Record<string, unknown>;

  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "DailyReportInputError";
    this.status = status;
    this.details = details ?? { error: message };
  }
}

const model = <T = any>(name: string): T | null => ((db as any)[name] as T | undefined) ?? null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorDetails = (error: unknown): string => {
  const record =
    error && typeof error === "object" && !Array.isArray(error)
      ? (error as Record<string, unknown>)
      : {};
  return [
    record.code,
    record.meta ? JSON.stringify(record.meta) : "",
    errorMessage(error),
  ].join(" ").toLowerCase();
};

const isMissingDailyReportSchemaError = (error: unknown): boolean => {
  const details = errorDetails(error);
  return (
    (details.includes("daily_report_settings") || details.includes("daily_report_runs")) &&
    (details.includes("p2021") ||
      details.includes("p2022") ||
      details.includes("p2010") ||
      details.includes("42p01") ||
      details.includes("undefined_table") ||
      details.includes("no such table") ||
      details.includes("does not exist"))
  );
};

const warnMissingDailyReportSchema = (context: string, error: unknown): void => {
  if (warnedMissingDailyReportSchema) {
    return;
  }
  warnedMissingDailyReportSchema = true;
  console.warn(
    `[daily-reports] ${context}: daily report tables are missing. Run 'pnpm -C web db:push'. (${errorMessage(error)})`,
  );
};

export const isValidTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
};

export const normalizeTimezone = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_TIMEZONE;
  }
  const trimmed = value.trim();
  return trimmed && isValidTimezone(trimmed) ? trimmed : DEFAULT_TIMEZONE;
};

export const normalizeSendTimeLocal = (value: unknown): string => {
  if (typeof value !== "string") {
    return DEFAULT_SEND_TIME_LOCAL;
  }
  const trimmed = value.trim();
  return SEND_TIME_PATTERN.test(trimmed) ? trimmed : DEFAULT_SEND_TIME_LOCAL;
};

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

export const normalizeDeliveryChannels = (value: unknown): DailyReportDeliveryChannel[] => {
  const raw = typeof value === "string" ? parseJson(value) : value;
  const values = Array.isArray(raw) ? raw : DEFAULT_DELIVERY_CHANNELS;
  const channels = values.flatMap((item) => {
    if (item === "in_app" || item === "feishu") {
      return [item];
    }
    return [];
  });
  return channels.length > 0 ? Array.from(new Set(channels)) : DEFAULT_DELIVERY_CHANNELS;
};

const dateToIsoOrNull = (value?: Date | null): string | null =>
  value ? value.toISOString() : null;

const partsForDate = (date: Date, timezone: string): Record<string, string> => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

export const formatReportDate = (date: Date, timezone: string): string => {
  const parts = partsForDate(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const formatReportTime = (date: Date, timezone: string): string => {
  const parts = partsForDate(date, timezone);
  return `${parts.hour}:${parts.minute}`;
};

const getTimezoneOffsetMs = (date: Date, timezone: string): number => {
  const parts = partsForDate(date, timezone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
};

const addDaysToReportDate = (reportDate: string, days: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reportDate);
  if (!match) {
    throw new DailyReportInputError("reportDate must use YYYY-MM-DD");
  }
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
};

export const normalizeReportDate = (value: unknown, timezone: string, now = new Date()): string => {
  if (typeof value !== "string" || !value.trim()) {
    return formatReportDate(now, timezone);
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new DailyReportInputError("reportDate must use YYYY-MM-DD");
  }
  return trimmed;
};

const localDateTimeToUtc = (reportDate: string, timeLocal: string, timezone: string): Date => {
  const [year, month, day] = reportDate.split("-").map(Number);
  const [hour, minute] = timeLocal.split(":").map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const firstGuess = new Date(localAsUtc);
  const firstOffset = getTimezoneOffsetMs(firstGuess, timezone);
  const secondGuess = new Date(localAsUtc - firstOffset);
  const secondOffset = getTimezoneOffsetMs(secondGuess, timezone);
  return new Date(localAsUtc - secondOffset);
};

export const computeReportDateRange = (reportDate: string, timezone: string): { start: Date; end: Date } => {
  const start = localDateTimeToUtc(reportDate, "00:00", timezone);
  const end = localDateTimeToUtc(addDaysToReportDate(reportDate, 1), "00:00", timezone);
  return { start, end };
};

export const computeNextRunAt = (input: {
  timezone: string;
  sendTimeLocal: string;
  now?: Date;
}): Date => {
  const now = input.now ?? new Date();
  const timezone = normalizeTimezone(input.timezone);
  const sendTimeLocal = normalizeSendTimeLocal(input.sendTimeLocal);
  const today = formatReportDate(now, timezone);
  const todayRun = localDateTimeToUtc(today, sendTimeLocal, timezone);
  if (todayRun.getTime() > now.getTime()) {
    return todayRun;
  }
  return localDateTimeToUtc(addDaysToReportDate(today, 1), sendTimeLocal, timezone);
};

const buildDefaultSetting = (userId: string, now = new Date()): DailyReportSettingRow => {
  const timezone = DEFAULT_TIMEZONE;
  const sendTimeLocal = DEFAULT_SEND_TIME_LOCAL;
  return {
    id: "",
    userId,
    enabled: false,
    timezone,
    sendTimeLocal,
    deliveryChannels: JSON.stringify(DEFAULT_DELIVERY_CHANNELS),
    nextRunAt: computeNextRunAt({ timezone, sendTimeLocal, now }),
    lastSentForDate: null,
    lastRunAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
};

export const serializeDailyReportSetting = (
  setting: DailyReportSettingRow,
): DailyReportSettingResponse => {
  const deliveryChannels = normalizeDeliveryChannels(setting.deliveryChannels);
  const sendTimeLocal = DEFAULT_SEND_TIME_LOCAL;
  return {
    enabled: Boolean(setting.enabled),
    timezone: normalizeTimezone(setting.timezone),
    sendTimeLocal,
    send_time_local: sendTimeLocal,
    deliveryChannels,
    delivery_channels: deliveryChannels,
    nextRunAt: dateToIsoOrNull(setting.nextRunAt),
    next_run_at: dateToIsoOrNull(setting.nextRunAt),
    lastSentForDate: setting.lastSentForDate ?? null,
    last_sent_for_date: setting.lastSentForDate ?? null,
    lastRunAt: dateToIsoOrNull(setting.lastRunAt),
    last_run_at: dateToIsoOrNull(setting.lastRunAt),
    lastError: setting.lastError ?? null,
    last_error: setting.lastError ?? null,
  };
};

export async function getDailyReportSetting(userId: string): Promise<DailyReportSettingResponse> {
  const dailyReportSetting = model("dailyReportSetting");
  if (!dailyReportSetting?.findUnique) {
    return serializeDailyReportSetting(buildDefaultSetting(userId));
  }

  try {
    const row = (await dailyReportSetting.findUnique({ where: { userId } })) as DailyReportSettingRow | null;
    return serializeDailyReportSetting(row ?? buildDefaultSetting(userId));
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("setting.get", error);
    return serializeDailyReportSetting(buildDefaultSetting(userId));
  }
}

export async function updateDailyReportSetting(input: {
  userId: string;
  enabled?: unknown;
  timezone?: unknown;
  deliveryChannels?: unknown;
  now?: Date;
}): Promise<DailyReportSettingResponse> {
  const dailyReportSetting = model("dailyReportSetting");
  if (!dailyReportSetting?.upsert) {
    throw new DailyReportSchemaUnavailableError();
  }

  const now = input.now ?? new Date();
  let existing: DailyReportSettingRow | null;
  try {
    existing = (await dailyReportSetting.findUnique({ where: { userId: input.userId } })) as
      | DailyReportSettingRow
      | null;
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("setting.update.read", error);
    throw new DailyReportSchemaUnavailableError();
  }
  const enabled = typeof input.enabled === "boolean" ? input.enabled : existing?.enabled ?? false;
  const timezone = input.timezone == null ? normalizeTimezone(existing?.timezone) : normalizeTimezone(input.timezone);
  if (input.timezone != null && typeof input.timezone === "string" && !isValidTimezone(input.timezone.trim())) {
    throw new DailyReportInputError("timezone is invalid");
  }
  const sendTimeLocal = DEFAULT_SEND_TIME_LOCAL;
  const deliveryChannels = normalizeDeliveryChannels(input.deliveryChannels ?? existing?.deliveryChannels);
  const nextRunAt = enabled ? computeNextRunAt({ timezone, sendTimeLocal, now }) : null;

  try {
    const row = (await dailyReportSetting.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        enabled,
        timezone,
        sendTimeLocal,
        deliveryChannels: JSON.stringify(deliveryChannels),
        nextRunAt,
      },
      update: {
        enabled,
        timezone,
        sendTimeLocal,
        deliveryChannels: JSON.stringify(deliveryChannels),
        nextRunAt,
        lastError: null,
      },
    })) as DailyReportSettingRow;
    return serializeDailyReportSetting(row);
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("setting.update", error);
    throw new DailyReportSchemaUnavailableError();
  }
}

const truncateText = (value: string, maxLength = 160): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trim()}...`;
};

const isWithinRange = (value: Date | null | undefined, start: Date, end: Date): value is Date =>
  Boolean(value && value.getTime() >= start.getTime() && value.getTime() < end.getTime());

const statusRank = (status: string): "completed" | "running" | "killed" | null => {
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed") return "completed";
  if (normalized === "running" || normalized === "init" || normalized === "killing") return "running";
  if (normalized === "killed" || normalized === "failed" || normalized === "cancelled") return "killed";
  return null;
};

const buildTaskEvents = (
  task: ReportTaskRow,
  start: Date,
  end: Date,
  timezone: string,
): DailyReportEvent[] => {
  const events: Array<DailyReportEvent & { sortAt: number }> = [];
  if (isWithinRange(task.createdAt, start, end)) {
    events.push({
      type: "task_created",
      timestamp: task.createdAt.toISOString(),
      sortAt: task.createdAt.getTime(),
      time: formatReportTime(task.createdAt, timezone),
      title: "Task created",
      detail: task.title,
      status: task.status,
    });
  }

  for (const event of task.taskStatusEvents ?? []) {
    if (!isWithinRange(event.createdAt, start, end)) continue;
    events.push({
      type: "status",
      timestamp: event.createdAt.toISOString(),
      sortAt: event.createdAt.getTime(),
      time: formatReportTime(event.createdAt, timezone),
      title: `Status changed to ${event.status}`,
      detail: event.summary ? truncateText(event.summary) : null,
      status: event.status,
    });
  }

  for (const message of task.messages ?? []) {
    if (!isWithinRange(message.createdAt, start, end)) continue;
    const normalizedRole = String(message.role || "").toLowerCase();
    const isUser = normalizedRole === "user";
    events.push({
      type: "message",
      timestamp: message.createdAt.toISOString(),
      sortAt: message.createdAt.getTime(),
      time: formatReportTime(message.createdAt, timezone),
      title: isUser ? "User message" : "AI update",
      detail: truncateText(message.content),
      role: normalizedRole || null,
    });
  }

  const killedAt = task.killedAt ?? null;
  if (isWithinRange(killedAt, start, end)) {
    events.push({
      type: "task_closed",
      timestamp: killedAt.toISOString(),
      sortAt: killedAt.getTime(),
      time: formatReportTime(killedAt, timezone),
      title: "Task stopped",
      detail: null,
      status: task.status,
    });
  } else if (
    isWithinRange(task.updatedAt, start, end) &&
    events.length === 0
  ) {
    events.push({
      type: "task_updated",
      timestamp: task.updatedAt.toISOString(),
      sortAt: task.updatedAt.getTime(),
      time: formatReportTime(task.updatedAt, timezone),
      title: "Task updated",
      detail: task.title,
      status: task.status,
    });
  }

  return events.sort((left, right) => left.sortAt - right.sortAt).map(({ sortAt: _sortAt, ...event }) => event);
};

const summarizeSegment = (task: ReportTaskRow, events: DailyReportEvent[]): string => {
  const messageCount = events.filter((event) => event.type === "message").length;
  const latestStatus = [...events].reverse().find((event) => event.status)?.status ?? task.status;
  const latestDetail = [...events].reverse().find((event) => event.detail)?.detail;
  const pieces = [
    `${messageCount} ${messageCount === 1 ? "message" : "messages"}`,
    `status ${latestStatus}`,
  ];
  if (latestDetail) {
    pieces.push(`latest: ${latestDetail}`);
  }
  return pieces.join("; ");
};

const renderTimeRange = (events: DailyReportEvent[]): string => {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first) return "";
  if (!last || first.time === last.time) return first.time;
  return `${first.time}-${last.time}`;
};

const buildMarkdown = (payload: DailyReportPayload): string => {
  const lines = [
    `# Daily Report - ${payload.reportDate}`,
    "",
    `Timezone: ${payload.timezone}`,
    "",
    "## Overview",
    `- Projects: ${payload.totals.projects}`,
    `- Tasks touched: ${payload.totals.tasks}`,
    `- Messages: ${payload.totals.messages}`,
    `- Completed: ${payload.totals.completed}`,
    `- Running: ${payload.totals.running}`,
    `- Killed: ${payload.totals.killed}`,
    "",
  ];

  if (payload.projects.length === 0) {
    lines.push("No task activity was recorded for this day.");
    return lines.join("\n");
  }

  for (const project of payload.projects) {
    lines.push(`## ${project.projectName}`);
    if (project.daemonHost) {
      lines.push(`Daemon: ${project.daemonHost}`);
    }
    lines.push(project.summary);
    lines.push("");
    for (const segment of project.timeline) {
      const issue = segment.issueTitle ? ` [${segment.issueTitle}]` : "";
      lines.push(`- ${segment.timeRange} ${segment.taskTitle}${issue} (${segment.status})`);
      lines.push(`  - ${segment.summary}`);
      for (const event of segment.events.slice(0, 4)) {
        const detail = event.detail ? `: ${event.detail}` : "";
        lines.push(`  - ${event.time} ${event.title}${detail}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
};

export async function generateDailyReport(input: {
  userId: string;
  reportDate?: string | null;
  timezone?: string | null;
  now?: Date;
  useAiSummary?: boolean;
}): Promise<{
  payload: DailyReportPayload;
  summaryMarkdown: string;
}> {
  const now = input.now ?? new Date();
  const timezone = normalizeTimezone(input.timezone);
  const reportDate = normalizeReportDate(input.reportDate, timezone, now);
  const { start, end } = computeReportDateRange(reportDate, timezone);

  const tasks = (await (db as any).task.findMany({
    where: {
      project: { userId: input.userId },
      OR: [
        { createdAt: { gte: start, lt: end } },
        { updatedAt: { gte: start, lt: end } },
        { killedAt: { gte: start, lt: end } },
        { messages: { some: { createdAt: { gte: start, lt: end } } } },
        { taskStatusEvents: { some: { createdAt: { gte: start, lt: end } } } },
      ],
    },
    include: {
      project: {
        select: {
          id: true,
          name: true,
          daemonHost: true,
        },
      },
      issue: {
        select: {
          title: true,
        },
      },
      messages: {
        where: { createdAt: { gte: start, lt: end } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
      taskStatusEvents: {
        where: { createdAt: { gte: start, lt: end } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
  })) as ReportTaskRow[];

  const projectMap = new Map<string, DailyReportProject>();
  const totals = {
    projects: 0,
    tasks: 0,
    messages: 0,
    completed: 0,
    running: 0,
    killed: 0,
  };

  for (const task of tasks) {
    const events = buildTaskEvents(task, start, end, timezone);
    if (events.length === 0) {
      continue;
    }
    const rank = statusRank(task.status);
    if (rank) {
      totals[rank] += 1;
    }
    totals.tasks += 1;
    const messageCount = events.filter((event) => event.type === "message").length;
    totals.messages += messageCount;

    const projectId = task.project.id;
    let project = projectMap.get(projectId);
    if (!project) {
      project = {
        projectId,
        project_id: projectId,
        projectName: task.project.name,
        project_name: task.project.name,
        daemonHost: task.project.daemonHost ?? null,
        daemon_host: task.project.daemonHost ?? null,
        summary: "",
        stats: {
          tasksTouched: 0,
          tasks_touched: 0,
          messages: 0,
          completed: 0,
          running: 0,
          killed: 0,
        },
        timeline: [],
      };
      projectMap.set(projectId, project);
    }

    project.stats.tasksTouched += 1;
    project.stats.tasks_touched += 1;
    project.stats.messages += messageCount;
    if (rank) {
      project.stats[rank] += 1;
    }
    const startAt = events[0].timestamp;
    const endAt = events.length > 1 ? events[events.length - 1].timestamp : null;
    project.timeline.push({
      taskId: task.id,
      task_id: task.id,
      taskTitle: task.title,
      task_title: task.title,
      issueTitle: task.issue?.title ?? null,
      issue_title: task.issue?.title ?? null,
      status: task.status,
      startAt,
      start_at: startAt,
      endAt,
      end_at: endAt,
      timeRange: renderTimeRange(events),
      time_range: renderTimeRange(events),
      summary: summarizeSegment(task, events),
      events,
    });
  }

  const projects = Array.from(projectMap.values())
    .map((project) => {
      project.timeline.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
      project.summary = `${project.stats.tasksTouched} ${
        project.stats.tasksTouched === 1 ? "task" : "tasks"
      } touched, ${project.stats.messages} messages, ${project.stats.completed} completed.`;
      return project;
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.timeline[0]?.startAt ?? "");
      const rightTime = Date.parse(right.timeline[0]?.startAt ?? "");
      return leftTime - rightTime || left.projectName.localeCompare(right.projectName);
    });
  totals.projects = projects.length;

  const payload: DailyReportPayload = {
    reportDate,
    report_date: reportDate,
    timezone,
    generatedAt: now.toISOString(),
    generated_at: now.toISOString(),
    rangeStart: start.toISOString(),
    range_start: start.toISOString(),
    rangeEnd: end.toISOString(),
    range_end: end.toISOString(),
    totals,
    projects,
  };

  const ruleSummaryMarkdown = buildMarkdown(payload);
  if (input.useAiSummary) {
    const summarized = await summarizeDailyReportWithGlm({
      payload,
      fallbackSummaryMarkdown: ruleSummaryMarkdown,
    });
    payload.summarizer = summarized.summarizer;
    return {
      payload,
      summaryMarkdown: summarized.summaryMarkdown,
    };
  }

  payload.summarizer = {
    provider: "rules",
    model: null,
    status: "not_requested",
    generatedAt: now.toISOString(),
    generated_at: now.toISOString(),
    error: null,
  };

  return {
    payload,
    summaryMarkdown: ruleSummaryMarkdown,
  };
}

export const serializeDailyReportRun = (
  row: DailyReportRunRow,
  persisted = true,
): DailyReportResponse => {
  const payload = parseJson(row.payloadJson) as DailyReportPayload | null;
  const deliveryChannels = normalizeDeliveryChannels(row.deliveryChannels);
  return {
    id: row.id,
    userId: row.userId,
    user_id: row.userId,
    reportDate: row.reportDate,
    report_date: row.reportDate,
    timezone: row.timezone,
    status: row.status,
    summaryMarkdown: row.summaryMarkdown,
    summary_markdown: row.summaryMarkdown,
    payload: payload ?? {
      reportDate: row.reportDate,
      report_date: row.reportDate,
      timezone: row.timezone,
      generatedAt: row.createdAt.toISOString(),
      generated_at: row.createdAt.toISOString(),
      rangeStart: row.createdAt.toISOString(),
      range_start: row.createdAt.toISOString(),
      rangeEnd: row.createdAt.toISOString(),
      range_end: row.createdAt.toISOString(),
      totals: { projects: 0, tasks: 0, messages: 0, completed: 0, running: 0, killed: 0 },
      projects: [],
    },
    deliveryChannels,
    delivery_channels: deliveryChannels,
    sentAt: dateToIsoOrNull(row.sentAt),
    sent_at: dateToIsoOrNull(row.sentAt),
    lastError: row.lastError ?? null,
    last_error: row.lastError ?? null,
    persisted,
    createdAt: row.createdAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
};

const serializePreview = (input: {
  userId: string;
  reportDate: string;
  timezone: string;
  summaryMarkdown: string;
  payload: DailyReportPayload;
  deliveryChannels?: DailyReportDeliveryChannel[];
  now?: Date;
}): DailyReportResponse => {
  const now = input.now ?? new Date();
  const row: DailyReportRunRow = {
    id: "",
    userId: input.userId,
    reportDate: input.reportDate,
    timezone: input.timezone,
    status: "preview",
    summaryMarkdown: input.summaryMarkdown,
    payloadJson: JSON.stringify(input.payload),
    deliveryChannels: JSON.stringify(input.deliveryChannels ?? DEFAULT_DELIVERY_CHANNELS),
    sentAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  return { ...serializeDailyReportRun(row, false), id: null };
};

export async function getDailyReport(input: {
  userId: string;
  reportDate?: string | null;
  timezone?: string | null;
  now?: Date;
}): Promise<DailyReportResponse> {
  const setting = await getDailyReportSetting(input.userId);
  const timezone = normalizeTimezone(input.timezone ?? setting.timezone);
  const reportDate = normalizeReportDate(input.reportDate, timezone, input.now);
  const dailyReportRun = model("dailyReportRun");
  if (dailyReportRun?.findUnique) {
    try {
      const row = (await dailyReportRun.findUnique({
        where: {
          userId_reportDate: {
            userId: input.userId,
            reportDate,
          },
        },
      })) as DailyReportRunRow | null;
      if (row) {
        return serializeDailyReportRun(row);
      }
    } catch (error) {
      if (!isMissingDailyReportSchemaError(error)) {
        throw error;
      }
      warnMissingDailyReportSchema("report.get", error);
    }
  }

  const generated = await generateDailyReport({
    userId: input.userId,
    reportDate,
    timezone,
    now: input.now,
  });
  return serializePreview({
    userId: input.userId,
    reportDate,
    timezone,
    summaryMarkdown: generated.summaryMarkdown,
    payload: generated.payload,
    deliveryChannels: setting.deliveryChannels,
    now: input.now,
  });
}

export async function persistDailyReport(input: {
  userId: string;
  reportDate?: string | null;
  timezone?: string | null;
  status?: string;
  sentAt?: Date | null;
  now?: Date;
}): Promise<DailyReportResponse> {
  const dailyReportRun = model("dailyReportRun");
  if (!dailyReportRun?.upsert) {
    throw new DailyReportSchemaUnavailableError();
  }
  const setting = await getDailyReportSetting(input.userId);
  const timezone = normalizeTimezone(input.timezone ?? setting.timezone);
  const reportDate = normalizeReportDate(input.reportDate, timezone, input.now);
  const generated = await generateDailyReport({
    userId: input.userId,
    reportDate,
    timezone,
    now: input.now,
    useAiSummary: true,
  });
  const deliveryChannels = setting.deliveryChannels;
  try {
    const row = (await dailyReportRun.upsert({
      where: {
        userId_reportDate: {
          userId: input.userId,
          reportDate,
        },
      },
      create: {
        userId: input.userId,
        reportDate,
        timezone,
        status: input.status ?? "generated",
        summaryMarkdown: generated.summaryMarkdown,
        payloadJson: JSON.stringify(generated.payload),
        deliveryChannels: JSON.stringify(deliveryChannels),
        sentAt: input.sentAt ?? null,
      },
      update: {
        timezone,
        status: input.status ?? "generated",
        summaryMarkdown: generated.summaryMarkdown,
        payloadJson: JSON.stringify(generated.payload),
        deliveryChannels: JSON.stringify(deliveryChannels),
        sentAt: input.sentAt ?? null,
        lastError: null,
      },
    })) as DailyReportRunRow;
    return serializeDailyReportRun(row);
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("report.persist", error);
    throw new DailyReportSchemaUnavailableError();
  }
}

export async function listDailyReportRuns(input: {
  userId: string;
  limit?: number;
}): Promise<DailyReportResponse[]> {
  const dailyReportRun = model("dailyReportRun");
  if (!dailyReportRun?.findMany) {
    return [];
  }
  try {
    const rows = (await dailyReportRun.findMany({
      where: { userId: input.userId },
      orderBy: { reportDate: "desc" },
      take: Math.max(1, Math.min(60, input.limit ?? 14)),
    })) as DailyReportRunRow[];
    return rows.map((row) => serializeDailyReportRun(row));
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("report.list", error);
    return [];
  }
}

export async function processDueDailyReports(options: {
  now?: Date;
  limit?: number;
} = {}): Promise<{ scanned: number; generated: number; skipped: number; failed: number }> {
  const dailyReportSetting = model("dailyReportSetting");
  if (!dailyReportSetting?.findMany || !dailyReportSetting?.update || !dailyReportSetting?.updateMany) {
    return { scanned: 0, generated: 0, skipped: 0, failed: 0 };
  }

  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_PROCESS_LIMIT;
  const stats = { scanned: 0, generated: 0, skipped: 0, failed: 0 };

  let settings: DailyReportSettingRow[];
  try {
    settings = (await dailyReportSetting.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
      },
      orderBy: { nextRunAt: "asc" },
      take: limit,
    })) as DailyReportSettingRow[];
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("process_due", error);
    return stats;
  }

  stats.scanned = settings.length;
  for (const setting of settings) {
    const timezone = normalizeTimezone(setting.timezone);
    const sendTimeLocal = DEFAULT_SEND_TIME_LOCAL;
    const reportDate = formatReportDate(now, timezone);
    const nextRunAt = computeNextRunAt({
      timezone,
      sendTimeLocal,
      now: new Date(now.getTime() + 1000),
    });

    if (setting.lastSentForDate === reportDate) {
      await dailyReportSetting.update({
        where: { id: setting.id },
        data: { nextRunAt, lastError: null },
      });
      stats.skipped += 1;
      continue;
    }

    const claimed = await dailyReportSetting.updateMany({
      where: {
        id: setting.id,
        enabled: true,
        nextRunAt: setting.nextRunAt,
      },
      data: {
        nextRunAt,
        lastError: null,
      },
    });
    if (claimed.count === 0) {
      continue;
    }

    try {
      const report = await persistDailyReport({
        userId: setting.userId,
        reportDate,
        timezone,
        status: "sent",
        sentAt: now,
        now,
      });
      await dailyReportSetting.update({
        where: { id: setting.id },
        data: {
          lastSentForDate: reportDate,
          lastRunAt: now,
          lastError: null,
          nextRunAt,
        },
      });
      if (report.deliveryChannels.includes("in_app")) {
        realtimeHub.broadcastToUser(setting.userId, {
          type: "daily_report_ready",
          payload: {
            id: report.id,
            report_date: report.reportDate,
            reportDate: report.reportDate,
            timezone: report.timezone,
            generated_at: report.updatedAt,
            generatedAt: report.updatedAt,
          },
        });
      }
      stats.generated += 1;
    } catch (error) {
      const message = errorMessage(error);
      await dailyReportSetting.update({
        where: { id: setting.id },
        data: {
          nextRunAt: new Date(now.getTime() + 5 * 60_000),
          lastRunAt: now,
          lastError: message,
        },
      });
      stats.failed += 1;
    }
  }

  return stats;
}

export async function reconcileDailyReportSchedules(options: {
  now?: Date;
  limit?: number;
} = {}): Promise<{ scanned: number; updated: number; skipped: number; failed: number }> {
  const dailyReportSetting = model("dailyReportSetting");
  if (!dailyReportSetting?.findMany || !dailyReportSetting?.update) {
    return { scanned: 0, updated: 0, skipped: 0, failed: 0 };
  }

  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;
  const stats = { scanned: 0, updated: 0, skipped: 0, failed: 0 };

  let settings: DailyReportSettingRow[];
  try {
    settings = (await dailyReportSetting.findMany({
      where: {
        enabled: true,
        OR: [
          { sendTimeLocal: { not: DEFAULT_SEND_TIME_LOCAL } },
          { nextRunAt: null },
        ],
      },
      orderBy: { updatedAt: "asc" },
      take: limit,
    })) as DailyReportSettingRow[];
  } catch (error) {
    if (!isMissingDailyReportSchemaError(error)) {
      throw error;
    }
    warnMissingDailyReportSchema("schedule.reconcile", error);
    return stats;
  }

  stats.scanned = settings.length;
  for (const setting of settings) {
    const timezone = normalizeTimezone(setting.timezone);
    const nextRunAt = computeNextRunAt({
      timezone,
      sendTimeLocal: DEFAULT_SEND_TIME_LOCAL,
      now,
    });

    try {
      await dailyReportSetting.update({
        where: { id: setting.id },
        data: {
          timezone,
          sendTimeLocal: DEFAULT_SEND_TIME_LOCAL,
          nextRunAt,
          lastError: null,
        },
      });
      stats.updated += 1;
    } catch (error) {
      if (!isMissingDailyReportSchemaError(error)) {
        throw error;
      }
      warnMissingDailyReportSchema("schedule.reconcile.update", error);
      stats.failed += 1;
    }
  }

  return stats;
}

export function startDailyReportDispatcher(options: {
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
    void processDueDailyReports({ limit })
      .catch((error) => {
        console.error(
          `[daily-reports] dispatcher tick failed: ${
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

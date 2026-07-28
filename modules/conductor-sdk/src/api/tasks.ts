import { ApiClient, SdkClientOptions, buildAuditMetadata } from './shared.js';

export interface Task {
  id: string;
  projectId: string | null;
  issueId?: string | null;
  title: string;
  status: string;
  backendType?: string | null;
  sessionId?: string | null;
  sessionFilePath?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  raw: Record<string, unknown>;
}

export interface Message {
  id: string;
  taskId?: string | null;
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  raw: Record<string, unknown>;
}

/** RFC 0033 — one member of a multi-agent task group. */
export interface TaskGroupMember {
  taskId: string;
  role: string | null;
  agent: string | null;
  title: string | null;
  status: string | null;
  backendType: string | null;
  isSelf: boolean;
}

/** RFC 0033 — the group a task belongs to (groupId null when standalone). */
export interface TaskGroup {
  groupId: string | null;
  members: TaskGroupMember[];
}

export type ScheduledMessageSchedule =
  | {
      mode: 'delay';
      amount: number;
      unit: 'minute' | 'hour';
    }
  | {
      mode: 'at';
      sendAt: string;
      timezone?: string | null;
    }
  | {
      mode: 'interval';
      every: number;
      unit: 'minute' | 'hour';
      condition?: 'none' | 'ai_idle';
      stop?: {
        maxRuns?: number | null;
        maxSkips?: number | null;
        stopAt?: string | null;
        stopWhenTaskNotRunning?: boolean | null;
      } | null;
    };

export interface ScheduledMessage {
  id: string;
  userId?: string | null;
  taskId: string;
  sourceMessageId?: string | null;
  content: string;
  kind: string;
  condition: string;
  intervalMs?: number | null;
  timezone?: string | null;
  status: string;
  nextRunAt: string;
  runCount: number;
  skipCount: number;
  failureCount: number;
  maxRuns?: number | null;
  maxSkips?: number | null;
  stopAt?: string | null;
  stopWhenTaskNotRunning: boolean;
  lastRunAt?: string | null;
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  raw: Record<string, unknown>;
}

const normalizeTask = (payload: Record<string, any>): Task => {
  const id = payload.id ? String(payload.id) : '';
  if (!id) {
    throw new Error('Task payload missing id');
  }
  return {
    id,
    projectId:
      payload.projectId !== undefined
        ? payload.projectId === null
          ? null
          : String(payload.projectId)
        : payload.project_id !== undefined
          ? payload.project_id === null
            ? null
            : String(payload.project_id)
          : null,
    issueId: payload.issueId ?? payload.issue_id ?? null,
    title: String(payload.title ?? ''),
    status: String(payload.status ?? ''),
    backendType: payload.backendType ?? payload.backend_type ?? null,
    sessionId: payload.sessionId ?? payload.session_id ?? null,
    sessionFilePath: payload.sessionFilePath ?? payload.session_file_path ?? null,
    createdAt: payload.createdAt ?? payload.created_at ?? null,
    updatedAt: payload.updatedAt ?? payload.updated_at ?? null,
    raw: payload,
  };
};

const asStringOrNull = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const normalizeTaskGroup = (payload: Record<string, any>): TaskGroup => {
  const rawMembers = Array.isArray(payload?.members) ? payload.members : [];
  const members: TaskGroupMember[] = rawMembers.map((m: Record<string, any>) => ({
    taskId: String(m?.task_id ?? m?.taskId ?? ''),
    role: asStringOrNull(m?.role),
    agent: asStringOrNull(m?.agent),
    title: asStringOrNull(m?.title),
    status: asStringOrNull(m?.status),
    backendType: asStringOrNull(m?.backend_type ?? m?.backendType),
    isSelf: Boolean(m?.is_self ?? m?.isSelf),
  }));
  return {
    groupId: asStringOrNull(payload?.group_id ?? payload?.groupId),
    members,
  };
};

const normalizeMessage = (payload: Record<string, any>): Message => {
  const id = payload.id ? String(payload.id) : payload.message_id ? String(payload.message_id) : '';
  if (!id) {
    throw new Error('Message payload missing id');
  }
  return {
    id,
    taskId: payload.taskId ?? payload.task_id ?? null,
    role: String(payload.role ?? ''),
    content: typeof payload.content === 'string' ? payload.content : '',
    metadata:
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? (payload.metadata as Record<string, unknown>)
        : null,
    createdAt: payload.createdAt ?? payload.created_at ?? null,
    raw: payload,
  };
};

const normalizeNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
};

const normalizeScheduledMessage = (payload: Record<string, any>): ScheduledMessage => {
  const id = payload.id ? String(payload.id) : '';
  if (!id) {
    throw new Error('Scheduled message payload missing id');
  }
  const taskId = payload.taskId ?? payload.task_id;
  if (!taskId) {
    throw new Error('Scheduled message payload missing taskId');
  }
  return {
    id,
    userId: payload.userId ?? payload.user_id ?? null,
    taskId: String(taskId),
    sourceMessageId: payload.sourceMessageId ?? payload.source_message_id ?? null,
    content: typeof payload.content === 'string' ? payload.content : '',
    kind: String(payload.kind ?? ''),
    condition: String(payload.condition ?? 'none'),
    intervalMs: payload.intervalMs ?? payload.interval_ms ?? null,
    timezone: payload.timezone ?? null,
    status: String(payload.status ?? ''),
    nextRunAt: String(payload.nextRunAt ?? payload.next_run_at ?? ''),
    runCount: normalizeNumber(payload.runCount ?? payload.run_count),
    skipCount: normalizeNumber(payload.skipCount ?? payload.skip_count),
    failureCount: normalizeNumber(payload.failureCount ?? payload.failure_count),
    maxRuns: payload.maxRuns ?? payload.max_runs ?? null,
    maxSkips: payload.maxSkips ?? payload.max_skips ?? null,
    stopAt: payload.stopAt ?? payload.stop_at ?? null,
    stopWhenTaskNotRunning: Boolean(payload.stopWhenTaskNotRunning ?? payload.stop_when_task_not_running),
    lastRunAt: payload.lastRunAt ?? payload.last_run_at ?? null,
    lastError: payload.lastError ?? payload.last_error ?? null,
    createdAt: payload.createdAt ?? payload.created_at ?? null,
    updatedAt: payload.updatedAt ?? payload.updated_at ?? null,
    raw: payload,
  };
};

export interface ListTasksInput {
  projectId?: string;
  issueId?: string;
  status?: string | string[];
}

export interface SendTaskMessageOptions {
  role?: string;
  metadata?: Record<string, unknown>;
  clientRequestId?: string;
}

export interface InsertTaskMessageOptions {
  metadata?: Record<string, unknown>;
  /**
   * The reply target of the in-flight turn to interrupt. When omitted, the
   * server resolves the most recent user message as the target.
   */
  targetReplyTo?: string;
}

export interface ListTaskMessagesOptions {
  limit?: number;
  before?: string;
}

export interface CreateScheduledMessageInput {
  content: string;
  schedule: ScheduledMessageSchedule;
  sourceMessageId?: string | null;
}

export class TasksApi {
  constructor(
    private readonly client: ApiClient,
    private readonly options: SdkClientOptions = {},
  ) {}

  async listTasks(input: ListTasksInput = {}): Promise<Task[]> {
    // The server `/api/tasks` only filters on `project_id`; status / issue
    // filtering happens client-side here so we can support both string and
    // array `status` shapes from the facade input.
    const tasks = await this.client.listTasks({
      projectId: input.projectId,
    });
    let normalized = (tasks as any[]).map((entry) =>
      normalizeTask(typeof entry.asObject === 'function' ? entry.asObject() : entry),
    );
    if (input.issueId) {
      normalized = normalized.filter((task) => task.issueId === input.issueId);
    }
    const statusFilter = Array.isArray(input.status)
      ? input.status.map((value) => String(value).trim()).filter(Boolean)
      : input.status
        ? [String(input.status).trim()].filter(Boolean)
        : [];
    if (statusFilter.length > 0) {
      const statusSet = new Set(statusFilter);
      normalized = normalized.filter((task) => statusSet.has(task.status));
    }
    return normalized;
  }

  async getTask(taskId: string): Promise<Task> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    const summary = await this.client.getTask(trimmed);
    return normalizeTask(
      typeof (summary as any).asObject === 'function'
        ? (summary as any).asObject()
        : (summary as any),
    );
  }

  /**
   * RFC 0033 — resolve the multi-agent group a task belongs to. Returns the
   * group id (null if the task is standalone) and every sibling task with its
   * role/agent. Agents use this to discover the task(s) they read from / send
   * feedback to.
   */
  async getTaskGroup(taskId: string): Promise<TaskGroup> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    const payload = await this.client.getTaskGroup(trimmed);
    return normalizeTaskGroup(payload);
  }

  async sendTaskMessage(
    taskId: string,
    content: string,
    options: SendTaskMessageOptions = {},
  ): Promise<Message> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('content is required');
    }
    const userMetadata = options.clientRequestId
      ? { clientRequestId: options.clientRequestId, ...(options.metadata ?? {}) }
      : options.metadata;
    const metadata = buildAuditMetadata(userMetadata, this.options);
    const body: Record<string, unknown> = {
      content,
      metadata,
    };
    if (options.role) {
      body.role = options.role;
    }
    const payload = await this.client.postTaskMessage(trimmed, body);
    return normalizeMessage(payload as Record<string, any>);
  }

  /**
   * Insert a mid-turn message into a running task. The message is delivered and
   * the in-flight turn is interrupted so the inserted message runs next, instead
   * of being queued until the current turn finishes (which is what
   * {@link sendTaskMessage} does).
   */
  async insertTaskMessage(
    taskId: string,
    content: string,
    options: InsertTaskMessageOptions = {},
  ): Promise<Message> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    if (typeof content !== 'string' || content.length === 0) {
      throw new Error('content is required');
    }
    const metadata = buildAuditMetadata(options.metadata, this.options);
    const body: Record<string, unknown> = {
      content,
      metadata,
    };
    if (options.targetReplyTo) {
      body.target_reply_to = options.targetReplyTo;
    }
    const payload = await this.client.postTaskInsert(trimmed, body);
    return normalizeMessage((payload as Record<string, any>).message ?? payload);
  }

  async listTaskMessages(
    taskId: string,
    options: ListTaskMessagesOptions = {},
  ): Promise<Message[]> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    const messages = await this.client.listTaskMessages(trimmed, {
      limit: options.limit,
      before: options.before,
    });
    return messages.map((entry) => normalizeMessage(entry));
  }

  async listScheduledMessages(taskId: string): Promise<ScheduledMessage[]> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    const schedules = await this.client.listScheduledMessages(trimmed);
    return schedules.map((entry) => normalizeScheduledMessage(entry));
  }

  async createScheduledMessage(
    taskId: string,
    input: CreateScheduledMessageInput,
  ): Promise<ScheduledMessage> {
    const trimmed = String(taskId ?? '').trim();
    if (!trimmed) {
      throw new Error('taskId is required');
    }
    const content = typeof input?.content === 'string' ? input.content.trim() : '';
    if (!content) {
      throw new Error('content is required');
    }
    if (!input?.schedule || typeof input.schedule !== 'object') {
      throw new Error('schedule is required');
    }
    const body: Record<string, unknown> = {
      content,
      schedule: input.schedule,
    };
    if (Object.prototype.hasOwnProperty.call(input, 'sourceMessageId')) {
      body.sourceMessageId = input.sourceMessageId ?? null;
    }
    const schedule = await this.client.createScheduledMessage(trimmed, body);
    return normalizeScheduledMessage(schedule);
  }

  async deleteScheduledMessage(taskId: string, scheduleId: string): Promise<void> {
    const trimmedTaskId = String(taskId ?? '').trim();
    const trimmedScheduleId = String(scheduleId ?? '').trim();
    if (!trimmedTaskId) {
      throw new Error('taskId is required');
    }
    if (!trimmedScheduleId) {
      throw new Error('scheduleId is required');
    }
    await this.client.deleteScheduledMessage(trimmedTaskId, trimmedScheduleId);
  }
}

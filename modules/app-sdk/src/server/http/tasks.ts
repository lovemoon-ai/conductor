/**
 * TasksApi: CRUD against `/api/tasks/*` plus message ops.
 *
 * Field naming reminder: backend accepts both snake_case and camelCase on
 * inbound requests but emits snake_case on responses. SDK normalizes to
 * camelCase internally.
 */
import { ConductorAppError } from '../../types/errors.js';
import type { Task, CreateTaskInput } from '../../types/task.js';
import type { Message, SendMessageInput } from '../../types/message.js';
import type { Fetcher } from '../fetcher.js';
import { normalizeTask, normalizeMessage } from '../normalize.js';
import { generateRequestId } from '../id.js';
import { SDK_NAME, SDK_VERSION } from '../../index.js';

/** @internal */
export class TasksRestApi {
  constructor(private readonly fetcher: Fetcher) {}

  async create(
    input: CreateTaskInput,
    opts?: { signal?: AbortSignal },
  ): Promise<Task> {
    if (!input.projectId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.create requires projectId',
      });
    }
    const trimmedTitle = input.title?.trim() ?? '';
    if (!trimmedTitle) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.create requires title',
      });
    }
    const raw = await this.fetcher.request({
      method: 'POST',
      path: '/api/tasks',
      body: {
        project_id: input.projectId,
        title: trimmedTitle,
        ...(input.initialMessage ? { initial_content: input.initialMessage } : {}),
        ...(input.backendType ? { backend_type: input.backendType } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
        task_type: 'ai_task',
      },
      signal: opts?.signal,
    });
    return normalizeTask(raw);
  }

  async get(taskId: string, opts?: { signal?: AbortSignal }): Promise<Task> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.get requires a taskId',
      });
    }
    const raw = await this.fetcher.request({
      method: 'GET',
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      signal: opts?.signal,
    });
    return normalizeTask(raw);
  }

  async list(
    filter: { projectId?: string; status?: string } = {},
    opts?: { signal?: AbortSignal },
  ): Promise<Task[]> {
    const raw = await this.fetcher.request<unknown>({
      method: 'GET',
      path: '/api/tasks',
      query: {
        ...(filter.projectId ? { project_id: filter.projectId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      signal: opts?.signal,
    });
    const list = Array.isArray(raw)
      ? raw
      : Array.isArray((raw as { tasks?: unknown }).tasks)
        ? (raw as { tasks: unknown[] }).tasks
        : [];
    return list.map((entry) => normalizeTask(entry));
  }

  async sendMessage(
    taskId: string,
    input: string | SendMessageInput,
    opts?: { signal?: AbortSignal },
  ): Promise<Message> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.sendMessage requires a taskId',
      });
    }
    const normalized = typeof input === 'string' ? { content: input } : input;
    if (!normalized.content || !normalized.content.trim()) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.sendMessage requires non-empty content',
      });
    }
    const clientRequestId = normalized.clientRequestId ?? generateRequestId();
    const raw = await this.fetcher.request({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/messages`,
      body: {
        content: normalized.content,
        role: normalized.role ?? 'sdk',
        clientRequestId,
        metadata: buildOutboundMetadata(normalized.metadata),
      },
      signal: opts?.signal,
    });
    return normalizeMessage(raw);
  }

  /**
   * Paginated history of messages for a task. Returns newest page first
   * (most recent messages have largest createdAt).
   */
  async history(
    taskId: string,
    paging: { beforeId?: string; limit?: number } = {},
    opts?: { signal?: AbortSignal },
  ): Promise<{
    messages: Message[];
    hasMoreBefore: boolean;
    oldestMessageId: string | null;
  }> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.history requires a taskId',
      });
    }
    const raw = await this.fetcher.request<HistoryResponse>({
      method: 'GET',
      path: `/api/tasks/${encodeURIComponent(taskId)}/messages`,
      query: {
        pagination: '1',
        ...(paging.beforeId ? { before_id: paging.beforeId } : {}),
        ...(paging.limit ? { limit: String(paging.limit) } : {}),
      },
      signal: opts?.signal,
    });
    if (!raw || typeof raw !== 'object') {
      return { messages: [], hasMoreBefore: false, oldestMessageId: null };
    }
    const messages = Array.isArray(raw.messages)
      ? raw.messages.map((entry) => normalizeMessage(entry))
      : [];
    const pagination = raw.pagination ?? {};
    return {
      messages,
      hasMoreBefore: Boolean(pagination.has_more_before),
      oldestMessageId:
        typeof pagination.oldest_message_id === 'string'
          ? pagination.oldest_message_id
          : null,
    };
  }

  async interrupt(
    taskId: string,
    opts: { targetReplyTo: string; signal?: AbortSignal },
  ): Promise<void> {
    if (!taskId) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.interrupt requires a taskId',
      });
    }
    if (!opts.targetReplyTo) {
      throw new ConductorAppError({
        code: 'invalid_input',
        message: 'tasks.interrupt requires targetReplyTo',
      });
    }
    await this.fetcher.request({
      method: 'POST',
      path: `/api/tasks/${encodeURIComponent(taskId)}/interrupt`,
      body: { target_reply_to: opts.targetReplyTo },
      signal: opts.signal,
    });
  }
}

type HistoryResponse = {
  messages?: unknown[];
  pagination?: {
    has_more_before?: boolean;
    oldest_message_id?: string | null;
    page_size?: number;
  };
};

/**
 * Build the outbound message metadata. SDK-managed audit fields
 * (`actor`, `sdkName`, `sdkVersion`) are stamped LAST so callers cannot
 * overwrite them — `audit.actor='app'` is a security marker used
 * downstream (e.g. `streamReply` to detect SDK echoes), not a free-form
 * field. Any incoming `metadata.audit.actor` is stripped explicitly to
 * make the intent obvious.
 *
 * Exported for unit testing.
 *
 * @internal
 */
export function buildOutboundMetadata(
  callerMetadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const base = callerMetadata && typeof callerMetadata === 'object' ? { ...callerMetadata } : {};
  const callerAudit =
    base.audit && typeof base.audit === 'object' && !Array.isArray(base.audit)
      ? { ...(base.audit as Record<string, unknown>) }
      : {};
  // Explicitly strip caller-supplied `actor` — only SDK may set this.
  delete callerAudit.actor;
  delete callerAudit.sdkName;
  delete callerAudit.sdkVersion;
  return {
    ...base,
    audit: {
      // Caller-supplied audit fields first…
      ...callerAudit,
      // …then SDK fields LAST so they always win.
      actor: 'app',
      sdkName: SDK_NAME,
      sdkVersion: SDK_VERSION,
    },
  };
}

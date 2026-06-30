import { ConductorConfig } from '../config/index.js';

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface BackendClientOptions {
  fetchImpl?: FetchFn;
  timeoutMs?: number;
}

export type AgentCommitEvent =
  | {
      eventType: 'sdk_message';
      taskId: string;
      content: string;
      metadata?: Record<string, unknown>;
      messageId?: string | null;
    }
  | {
      eventType: 'task_status_update';
      taskId: string;
      status: string;
      summary?: string | null;
      statusEventId?: string | null;
    }
  | {
      eventType: 'agent_command_ack';
      requestId: string;
      taskId?: string | null;
      accepted?: boolean;
      commandEventType?: string | null;
    }
  | {
      eventType: 'task_stop_ack';
      taskId: string;
      requestId: string;
      accepted?: boolean;
    };

export class BackendApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ProjectSummary {
  constructor(
    public readonly id: string,
    public readonly name?: string,
    public readonly daemonHost?: string | null,
    public readonly workspacePath?: string | null,
    public readonly repoRoot?: string | null,
    public readonly worktreeBranch?: string | null,
    public readonly lastCommit?: string | null,
    public readonly fileCount?: number | null,
    public readonly isDefault?: boolean,
    public readonly lastCommitAt?: string | null,
  ) {}

  static fromJSON(payload: Record<string, any>): ProjectSummary {
    const id = payload.id ? String(payload.id) : '';
    if (!id) {
      throw new Error('Project payload missing id');
    }
    return new ProjectSummary(
      id,
      payload.name ?? undefined,
      payload.daemonHost ?? payload.daemon_host ?? null,
      payload.workspacePath ?? payload.workspace_path ?? null,
      payload.repoRoot ?? payload.repo_root ?? null,
      payload.worktreeBranch ?? payload.worktree_branch ?? null,
      payload.lastCommit ?? payload.last_commit ?? null,
      payload.fileCount ?? payload.file_count ?? null,
      payload.isDefault ?? payload.is_default ?? undefined,
      payload.lastCommitAt ?? payload.last_commit_at ?? null,
    );
  }

  asObject(): Record<string, unknown> {
    return {
      id: this.id,
      name: this.name,
      daemonHost: this.daemonHost,
      workspacePath: this.workspacePath,
      repoRoot: this.repoRoot,
      worktreeBranch: this.worktreeBranch,
      lastCommit: this.lastCommit,
      lastCommitAt: this.lastCommitAt,
      fileCount: this.fileCount,
      isDefault: this.isDefault,
    };
  }
}

export class TaskSummary {
  constructor(
    public readonly id: string,
    public readonly projectId: string | null,
    public readonly title: string,
    public readonly status: string,
    public readonly backendType?: string | null,
    public readonly sessionId?: string | null,
    public readonly sessionFilePath?: string | null,
    public readonly createdAt?: string | null,
    public readonly updatedAt?: string | null,
  ) {}

  static fromJSON(payload: Record<string, any>): TaskSummary {
    const id = payload.id ? String(payload.id) : '';
    if (!id) {
      throw new Error('Task payload missing id');
    }
    const title = payload.title ? String(payload.title) : '';
    const status = payload.status ? String(payload.status) : '';
    if (!title || !status) {
      throw new Error('Task payload missing required fields');
    }
    return new TaskSummary(
      id,
      payload.project_id ? String(payload.project_id) : null,
      title,
      status,
      payload.backend_type ?? payload.backendType ?? null,
      payload.session_id ?? payload.sessionId ?? null,
      payload.session_file_path ?? payload.sessionFilePath ?? null,
      payload.created_at ?? null,
      payload.updated_at ?? null,
    );
  }
}

export class BackendApiClient {
  private readonly fetchImpl: FetchFn;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: ConductorConfig, options: BackendClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalFetch();
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.baseUrl = config.backendUrl.replace(/\/+$/, '');
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const response = await this.request('GET', '/projects');
    const payload = await this.parseJson(response);
    if (!Array.isArray(payload)) {
      throw new BackendApiError('Invalid projects response: expected list', response.status, payload);
    }
    const results: ProjectSummary[] = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      try {
        results.push(ProjectSummary.fromJSON(entry as Record<string, any>));
      } catch {
        continue;
      }
    }
    return results;
  }

  async createProject(params: {
    name?: string;
    metadata?: Record<string, unknown>;
    isDefault?: boolean;
    bindingConfirmed?: boolean;
    daemonHost?: string;
    workspacePath?: string;
    repoRoot?: string;
    worktreeBranch?: string;
    lastCommit?: string;
    lastCommitAt?: string;
    fileCount?: number;
  }): Promise<ProjectSummary> {
    const response = await this.request('POST', '/projects', {
      body: JSON.stringify(params),
    });
    const payload = await this.parseJson(response);
    return ProjectSummary.fromJSON(payload);
  }

  async listTasks(params: { projectId?: string; status?: string } = {}): Promise<TaskSummary[]> {
    const query = new URLSearchParams();
    if (params.projectId) {
      query.set('project_id', params.projectId);
    }
    if (params.status) {
      query.set('status', params.status);
    }
    const response = await this.request('GET', '/tasks', {
      query,
    });
    const payload = await this.parseJson(response);
    if (!Array.isArray(payload)) {
      throw new BackendApiError('Invalid tasks response: expected list', response.status, payload);
    }
    const tasks: TaskSummary[] = [];
    for (const entry of payload) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      try {
        tasks.push(TaskSummary.fromJSON(entry as Record<string, any>));
      } catch {
        continue;
      }
    }
    return tasks;
  }

  async createTask(params: {
    id?: string;
    projectId: string;
    title: string;
    status?: string;
    backendType?: string;
    sessionId?: string | null;
    sessionFilePath?: string | null;
    initialContent?: string;
    agentHost?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TaskSummary> {
    const response = await this.request('POST', '/tasks', {
      body: JSON.stringify(params),
    });
    const payload = await this.parseJson(response);
    return TaskSummary.fromJSON(payload);
  }

  async getTask(taskId: string): Promise<TaskSummary> {
    const response = await this.request('GET', `/tasks/${taskId}`);
    const payload = await this.parseJson(response);
    return TaskSummary.fromJSON(payload);
  }

  async updateTask(
    taskId: string,
    params: {
      projectId?: string;
      title?: string;
      status?: string;
      agentHost?: string | null;
      metadata?: Record<string, unknown> | null;
      backendType?: string | null;
      sessionId?: string | null;
      sessionFilePath?: string | null;
    },
  ): Promise<TaskSummary> {
    const response = await this.request('PATCH', `/tasks/${taskId}`, {
      body: JSON.stringify(params),
    });
    const payload = await this.parseJson(response);
    return TaskSummary.fromJSON(payload);
  }

  async createMessage(params: {
    taskId: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<any> {
    const response = await this.request('POST', `/tasks/${params.taskId}/messages`, {
      body: JSON.stringify(params),
    });
    return this.parseJson(response);
  }

  async commitAgentEvents(params: {
    agentHost: string;
    events: AgentCommitEvent[];
  }): Promise<{ results: Array<Record<string, unknown>> }> {
    const response = await this.request('POST', '/agent/events', {
      body: JSON.stringify({
        agent_host: params.agentHost,
        events: params.events.map((event) => {
          if (event.eventType === 'sdk_message') {
            return {
              event_type: event.eventType,
              task_id: event.taskId,
              content: event.content,
              metadata: event.metadata,
              message_id: event.messageId ?? undefined,
            };
          }
          if (event.eventType === 'task_status_update') {
            return {
              event_type: event.eventType,
              task_id: event.taskId,
              status: event.status,
              summary: event.summary ?? undefined,
              status_event_id: event.statusEventId ?? undefined,
            };
          }
          if (event.eventType === 'task_stop_ack') {
            return {
              event_type: event.eventType,
              task_id: event.taskId,
              request_id: event.requestId,
              accepted: event.accepted !== false,
            };
          }
          return {
            event_type: event.eventType,
            request_id: event.requestId,
            task_id: event.taskId ?? undefined,
            accepted: event.accepted !== false,
            command_event_type: event.commandEventType ?? undefined,
          };
        }),
      }),
    });
    return this.parseJson(response);
  }

  async commitSdkMessage(params: {
    agentHost: string;
    taskId: string;
    content: string;
    metadata?: Record<string, unknown>;
    messageId?: string | null;
  }): Promise<Record<string, unknown>> {
    const payload = await this.commitAgentEvents({
      agentHost: params.agentHost,
      events: [
        {
          eventType: 'sdk_message',
          taskId: params.taskId,
          content: params.content,
          metadata: params.metadata,
          messageId: params.messageId,
        },
      ],
    });
    return (Array.isArray(payload.results) ? payload.results[0] : null) ?? {};
  }

  async commitTaskStatusUpdate(params: {
    agentHost: string;
    taskId: string;
    status: string;
    summary?: string | null;
    statusEventId?: string | null;
  }): Promise<Record<string, unknown>> {
    const payload = await this.commitAgentEvents({
      agentHost: params.agentHost,
      events: [
        {
          eventType: 'task_status_update',
          taskId: params.taskId,
          status: params.status,
          summary: params.summary,
          statusEventId: params.statusEventId,
        },
      ],
    });
    return (Array.isArray(payload.results) ? payload.results[0] : null) ?? {};
  }

  async commitAgentCommandAck(params: {
    agentHost: string;
    requestId: string;
    taskId?: string | null;
    accepted?: boolean;
    commandEventType?: string | null;
  }): Promise<Record<string, unknown>> {
    const payload = await this.commitAgentEvents({
      agentHost: params.agentHost,
      events: [
        {
          eventType: 'agent_command_ack',
          requestId: params.requestId,
          taskId: params.taskId,
          accepted: params.accepted,
          commandEventType: params.commandEventType,
        },
      ],
    });
    return (Array.isArray(payload.results) ? payload.results[0] : null) ?? {};
  }

  async commitTaskStopAck(params: {
    agentHost: string;
    taskId: string;
    requestId: string;
    accepted?: boolean;
  }): Promise<Record<string, unknown>> {
    const payload = await this.commitAgentEvents({
      agentHost: params.agentHost,
      events: [
        {
          eventType: 'task_stop_ack',
          taskId: params.taskId,
          requestId: params.requestId,
          accepted: params.accepted,
        },
      ],
    });
    return (Array.isArray(payload.results) ? payload.results[0] : null) ?? {};
  }

  async matchProjectByPath(params: {
    hostname?: string;
    daemonHost?: string;
    daemon_host?: string;
    path: string;
  }): Promise<{ project: ProjectSummary | null; matchedPath: string | null }> {
    const response = await this.request('POST', '/projects/match-path', {
      body: JSON.stringify(params),
    });
    const payload = await this.parseJson(response);
    return {
      project: payload.project ? ProjectSummary.fromJSON(payload.project) : null,
      matchedPath: payload.matched_path ?? null,
    };
  }

  async getProject(projectId: string): Promise<{
    id: string;
    name?: string;
    metadata?: Record<string, unknown>;
    daemonHost?: string | null;
    workspacePath?: string | null;
    repoRoot?: string | null;
    worktreeBranch?: string | null;
    lastCommit?: string | null;
    lastCommitAt?: string | null;
    fileCount?: number | null;
    isDefault?: boolean;
  }> {
    const response = await this.request('GET', `/projects/${projectId}`);
    const payload = await this.parseJson(response);
    return {
      id: payload.id,
      name: payload.name,
      metadata: payload.metadata ?? undefined,
      daemonHost: payload.daemonHost ?? payload.daemon_host ?? undefined,
      workspacePath: payload.workspacePath ?? payload.workspace_path ?? undefined,
      repoRoot: payload.repoRoot ?? payload.repo_root ?? undefined,
      worktreeBranch: payload.worktreeBranch ?? payload.worktree_branch ?? undefined,
      lastCommit: payload.lastCommit ?? payload.last_commit ?? undefined,
      lastCommitAt: payload.lastCommitAt ?? payload.last_commit_at ?? undefined,
      fileCount: payload.fileCount ?? payload.file_count ?? undefined,
      isDefault: payload.isDefault ?? payload.is_default ?? undefined,
    };
  }

  async updateProject(projectId: string, params: {
    name?: string;
    metadata?: Record<string, unknown>;
    bindingConfirmed?: boolean;
    daemonHost?: string;
    workspacePath?: string;
    repoRoot?: string;
    worktreeBranch?: string;
    lastCommit?: string;
    lastCommitAt?: string;
    fileCount?: number;
  }): Promise<ProjectSummary> {
    const response = await this.request('PATCH', `/projects/${projectId}`, {
      body: JSON.stringify(params),
    });
    const payload = await this.parseJson(response);
    return ProjectSummary.fromJSON(payload);
  }

  /**
   * PATCH /projects?projectId=... — used for fields the per-id PATCH endpoint
   * doesn't accept (today: `hidden`). The two PATCH endpoints intentionally
   * have different surfaces; see web/src/app/api/projects/route.ts vs
   * web/src/app/api/projects/[projectId]/route.ts.
   */
  async patchProjectByQuery(
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const query = new URLSearchParams();
    query.set('projectId', projectId);
    const response = await this.request('PATCH', '/projects', {
      query,
      body: JSON.stringify(params),
    });
    return this.parseJson(response);
  }

  /**
   * POST /projects/default — switches the user's default project to
   * `projectId`. Returns the serialized Project (with `is_default: true`).
   * Extra body fields (e.g., `metadata`) are merged into the request so the
   * facade can pass audit info through.
   */
  async setDefaultProject(
    projectId: string,
    extraBody: Record<string, unknown> = {},
  ): Promise<Record<string, any>> {
    const response = await this.request('POST', '/projects/default', {
      body: JSON.stringify({ projectId, ...extraBody }),
    });
    return this.parseJson(response);
  }

  async listIssues(params: {
    projectId?: string;
    projectIds?: string[];
    status?: string;
  } = {}): Promise<Record<string, any>[]> {
    const query = new URLSearchParams();
    if (params.projectId) {
      query.set('project_id', params.projectId);
    }
    if (params.projectIds && params.projectIds.length > 0) {
      query.set('project_ids', params.projectIds.join(','));
    }
    if (params.status) {
      query.set('status', params.status);
    }
    const response = await this.request('GET', '/issues', { query });
    const payload = await this.parseJson(response);
    if (!Array.isArray(payload)) {
      throw new BackendApiError('Invalid issues response: expected list', response.status, payload);
    }
    return payload as Record<string, any>[];
  }

  async getIssue(issueId: string): Promise<Record<string, any>> {
    const response = await this.request('GET', `/issues/${issueId}`);
    return this.parseJson(response);
  }

  async createIssue(params: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await this.request('POST', '/issues', {
      body: JSON.stringify(params),
    });
    return this.parseJson(response);
  }

  async patchIssue(issueId: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await this.request('PATCH', `/issues/${issueId}`, {
      body: JSON.stringify(params),
    });
    return this.parseJson(response);
  }

  async deleteIssue(issueId: string): Promise<void> {
    await this.request('DELETE', `/issues/${issueId}`);
  }

  async listTaskMessages(
    taskId: string,
    params: { limit?: number; before?: string } = {},
  ): Promise<Record<string, any>[]> {
    const query = new URLSearchParams();
    query.set('pagination', '1');
    if (typeof params.limit === 'number' && Number.isFinite(params.limit)) {
      query.set('limit', String(params.limit));
    }
    if (params.before) {
      query.set('before_id', params.before);
    }
    const response = await this.request('GET', `/tasks/${taskId}/messages`, { query });
    const payload = await this.parseJson(response);
    if (Array.isArray(payload)) {
      return payload as Record<string, any>[];
    }
    if (payload && typeof payload === 'object' && Array.isArray((payload as any).messages)) {
      return (payload as any).messages as Record<string, any>[];
    }
    throw new BackendApiError('Invalid messages response', response.status, payload);
  }

  /**
   * POST /tasks/[taskId]/messages — direct REST call. Note: `BackendApiClient`
   * has a higher-level `commitSdkMessage` that goes through the agent-events
   * pipeline (durable outbox + WS scope), but the CLI/AI Agent flow is a
   * one-shot HTTP write with no agent host context, so we use the REST
   * endpoint directly here. (RFC 0025 §2 picks the simpler path.)
   */
  async postTaskMessage(taskId: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await this.request('POST', `/tasks/${taskId}/messages`, {
      body: JSON.stringify(params),
    });
    return this.parseJson(response);
  }

  /**
   * POST /tasks/[taskId]/insert — insert a mid-turn message. Unlike
   * {@link postTaskMessage}, which queues a message for after the current turn,
   * this interrupts the running turn so the inserted message is processed next.
   */
  async postTaskInsert(taskId: string, params: Record<string, unknown>): Promise<Record<string, any>> {
    const response = await this.request('POST', `/tasks/${taskId}/insert`, {
      body: JSON.stringify(params),
    });
    return this.parseJson(response);
  }

  private async request(
    method: string,
    pathname: string,
    opts: { body?: any; query?: URLSearchParams } = {},
  ): Promise<Response> {
    const url = this.buildUrl(pathname, opts.query);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      let response = await this.sendRequest(url, method, opts.body, controller);
      if (
        response.status === 404 &&
        this.shouldRetryWithApiPrefix(pathname, url)
      ) {
        const retryUrl = this.buildUrl(this.withApiPrefix(pathname), opts.query);
        response = await this.sendRequest(retryUrl, method, opts.body, controller);
      }
      if (!response.ok) {
        const details = await this.safeJson(response);
        throw new BackendApiError(
          `Backend responded with ${response.status}`,
          response.status,
          details,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof BackendApiError) {
        throw error;
      }
      throw new BackendApiError(
        `Backend request failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        error instanceof Error ? { cause: error } : undefined,
      );
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private buildUrl(pathname: string, query?: URLSearchParams): URL {
    const url = new URL(`${this.baseUrl}${pathname}`);
    if (query) {
      query.forEach((value, key) => url.searchParams.set(key, value));
    }
    return url;
  }

  private async sendRequest(
    url: URL,
    method: string,
    body: any,
    controller: AbortController | null,
  ): Promise<Response> {
    return this.fetchImpl(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${this.config.agentToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      signal: controller?.signal,
    });
  }

  private shouldRetryWithApiPrefix(pathname: string, url: URL): boolean {
    if (!pathname.startsWith('/')) return false;
    if (pathname === '/api' || pathname.startsWith('/api/')) return false;
    // If backendUrl already includes /api in the base path, don't retry.
    return !url.pathname.startsWith('/api/');
  }

  private withApiPrefix(pathname: string): string {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return pathname;
    }
    return `/api${pathname}`;
  }

  private async parseJson(response: Response): Promise<any> {
    try {
      return await response.json();
    } catch (error) {
      throw new BackendApiError('Failed to parse backend response as JSON', response.status, null, {
        cause: error instanceof Error ? error : undefined,
      });
    }
  }

  private async safeJson(response: Response): Promise<any> {
    try {
      return await response.json();
    } catch {
      try {
        return await response.text();
      } catch {
        return null;
      }
    }
  }
}

function globalFetch(): FetchFn {
  if (typeof fetch === 'function') {
    return fetch.bind(globalThis);
  }
  throw new Error('Global fetch is not available; provide fetchImpl');
}

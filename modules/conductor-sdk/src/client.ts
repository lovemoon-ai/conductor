import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { buildFireHostName } from './agent-host.js';
import { BackendApiClient, BackendApiError } from './backend/index.js';
import { AttachmentMaterializer } from './attachments/index.js';
import { ConductorConfig, loadConfig } from './config/index.js';
import { ProjectContext } from './context/index.js';
import { getPlanLimitMessageFromError } from './limits/index.js';
import { MessageRouter } from './message/index.js';
import {
  DownstreamCommandCursor,
  DownstreamInboxStore,
  DurableDownstreamCommand,
  DownstreamCursorStore,
  DurableUpstreamEvent,
  DurableUpstreamEventType,
  DurableUpstreamOutboxStore,
  normalizeDownstreamCommandCursor,
} from './outbox/index.js';
import { SessionDiskStore, SessionManager, currentHostname } from './session/index.js';
import {
  ConductorWebSocketClient,
  WebSocketConnectedEvent,
  WebSocketDisconnectEvent,
  WebSocketPongEvent,
  WebSocketHandler,
} from './ws/index.js';

type BackendEnvelope = Record<string, any>;

type BackendApiLike = Pick<
  BackendApiClient,
  | 'listProjects'
  | 'createProject'
  | 'listTasks'
  | 'getTask'
  | 'createTask'
  | 'updateTask'
  | 'commitSdkMessage'
  | 'commitTaskStatusUpdate'
  | 'commitAgentCommandAck'
  | 'commitTaskStopAck'
  | 'matchProjectByPath'
  | 'getProject'
  | 'updateProject'
>;

type RealtimeClientLike = Pick<
  ConductorWebSocketClient,
  'registerHandler' | 'connect' | 'disconnect' | 'sendJson'
> & Partial<Pick<ConductorWebSocketClient, 'forceReconnect'>>;

export interface ConductorClientConnectOptions {
  config?: ConductorConfig;
  configFile?: string;
  env?: Record<string, string | undefined>;
  extraEnv?: Record<string, string | undefined>;
  projectPath?: string;
  deliveryScopeId?: string;
  backendApi?: BackendApiLike;
  wsClient?: RealtimeClientLike;
  sessionManager?: SessionManager;
  sessionStore?: SessionDiskStore;
  messageRouter?: MessageRouter;
  upstreamOutbox?: DurableUpstreamOutboxStore;
  downstreamCursorStore?: DownstreamCursorStore;
  downstreamInboxStore?: DownstreamInboxStore;
  attachmentMaterializer?: AttachmentMaterializer;
  agentHost?: string;
  extraHeaders?: Record<string, string>;
  onConnected?: (event: WebSocketConnectedEvent) => void;
  onDisconnected?: (event: WebSocketDisconnectEvent) => void;
  onPong?: (event: WebSocketPongEvent) => void;
  onStopTask?: (event: StopTaskEvent) => Promise<void> | void;
  onInterruptTurn?: (event: InterruptTurnEvent) => Promise<boolean | void> | boolean | void;
  onRefreshSession?: (event: RefreshSessionEvent) => Promise<boolean | void> | boolean | void;
}

interface ConductorClientInit {
  config: ConductorConfig;
  env: Record<string, string | undefined>;
  projectPath: string;
  deliveryScopeId: string;
  backendApi: BackendApiLike;
  wsClient: RealtimeClientLike;
  sessionManager: SessionManager;
  sessionStore: SessionDiskStore;
  messageRouter: MessageRouter;
  upstreamOutbox: DurableUpstreamOutboxStore;
  downstreamCursorStore: DownstreamCursorStore;
  downstreamInboxStore: DownstreamInboxStore;
  attachmentMaterializer: AttachmentMaterializer;
  agentHost: string;
  onStopTask?: (event: StopTaskEvent) => Promise<void> | void;
  onInterruptTurn?: (event: InterruptTurnEvent) => Promise<boolean | void> | boolean | void;
  onRefreshSession?: (event: RefreshSessionEvent) => Promise<boolean | void> | boolean | void;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepWithSignal = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) return resolve();
  const timer = setTimeout(resolve, Math.max(0, ms));
  timer.unref?.();
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export interface StopTaskEvent {
  taskId: string;
  requestId?: string;
  reason?: string;
}

export interface InterruptTurnEvent {
  taskId: string;
  requestId?: string;
  reason?: string;
  targetReplyTo: string;
}

export interface RefreshSessionEvent {
  taskId: string;
  requestId?: string;
  reason?: string;
  sessionId: string;
  sessionFilePath?: string;
}

export interface FlushPendingUpstreamEventsOptions {
  timeoutMs?: number;
  retryIntervalMs?: number;
}

export class ConductorClient {
  private readonly config: ConductorConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly projectPath: string;
  private readonly backendApi: BackendApiLike;
  private readonly wsClient: RealtimeClientLike;
  private readonly sessions: SessionManager;
  private readonly sessionStore: SessionDiskStore;
  private readonly messageRouter: MessageRouter;
  private upstreamOutbox: DurableUpstreamOutboxStore;
  private downstreamCursorStore: DownstreamCursorStore;
  private downstreamInboxStore: DownstreamInboxStore;
  private readonly attachmentMaterializer: AttachmentMaterializer;
  private readonly agentHost: string;
  private readonly onStopTask?: (event: StopTaskEvent) => Promise<void> | void;
  private readonly onInterruptTurn?: (event: InterruptTurnEvent) => Promise<boolean | void> | boolean | void;
  private readonly onRefreshSession?: (event: RefreshSessionEvent) => Promise<boolean | void> | boolean | void;
  private deliveryScopeId: string;
  private closed = false;
  private durableOutboxFlushPromise: Promise<void> | null = null;
  private durableOutboxTimer: NodeJS.Timeout | null = null;
  private durableOutboxTimerDueAt: number | null = null;
  private readonly downstreamTasks = new Map<string, Promise<void>>();
  private readonly queuedDownstreamRequests = new Set<string>();
  private readonly cancelledDownstreamTasks = new Set<string>();
  private readonly downstreamWorkerAbort = new AbortController();
  private downstreamClosing = false;

  constructor(init: ConductorClientInit) {
    this.config = init.config;
    this.env = init.env;
    this.projectPath = init.projectPath;
    this.backendApi = init.backendApi;
    this.wsClient = init.wsClient;
    this.sessions = init.sessionManager;
    this.sessionStore = init.sessionStore;
    this.messageRouter = init.messageRouter;
    this.upstreamOutbox = init.upstreamOutbox;
    this.downstreamCursorStore = init.downstreamCursorStore;
    this.downstreamInboxStore = init.downstreamInboxStore;
    this.attachmentMaterializer = init.attachmentMaterializer;
    this.agentHost = init.agentHost;
    this.onStopTask = init.onStopTask;
    this.onInterruptTurn = init.onInterruptTurn;
    this.onRefreshSession = init.onRefreshSession;
    this.deliveryScopeId = init.deliveryScopeId;
    this.wsClient.registerHandler(this.handleBackendEvent);
  }

  static async connect(options: ConductorClientConnectOptions = {}): Promise<ConductorClient> {
    const env = options.extraEnv ?? options.env ?? process.env;
    const config = options.config ?? loadConfig(options.configFile, { env });
    const projectPath = options.projectPath ?? process.cwd();
    const backendApi = options.backendApi ?? new BackendApiClient(config);
    const sessions = options.sessionManager ?? new SessionManager();
    const sessionStore = options.sessionStore ?? SessionDiskStore.forBackendUrl(config.backendUrl, env);
    const messageRouter = options.messageRouter ?? new MessageRouter(sessions);
    const agentHost = resolveAgentHost(env, options.agentHost);
    const deliveryScopeId = normalizeDeliveryScopeId(options.deliveryScopeId ?? `agent:${agentHost}`);
    const upstreamOutbox =
      options.upstreamOutbox ?? DurableUpstreamOutboxStore.forProjectPath(projectPath, deliveryScopeId);
    const downstreamCursorStore =
      options.downstreamCursorStore ?? DownstreamCursorStore.forProjectPath(projectPath, deliveryScopeId);
    const downstreamInboxStore =
      options.downstreamInboxStore ?? DownstreamInboxStore.forProjectPath(projectPath, deliveryScopeId);
    const attachmentMaterializer = options.attachmentMaterializer ?? new AttachmentMaterializer({
      config,
      projectPath,
      agentHost,
    });
    const wsClient =
      options.wsClient ??
      new ConductorWebSocketClient(config, {
        hostName: agentHost,
        extraHeaders: options.extraHeaders,
        onConnected: options.onConnected,
        onDisconnected: options.onDisconnected,
        onPong: options.onPong,
        onReconnected: () => {
          if (client.shouldAutoFlushDurableOutbox()) {
            void client.requestDurableOutboxFlush(true);
          }
        },
      });

    const client = new ConductorClient({
      config,
      env,
      projectPath,
      deliveryScopeId,
      backendApi,
      wsClient,
      sessionManager: sessions,
      sessionStore,
      messageRouter,
      upstreamOutbox,
      downstreamCursorStore,
      downstreamInboxStore,
      attachmentMaterializer,
      agentHost,
      onStopTask: options.onStopTask,
      onInterruptTurn: options.onInterruptTurn,
      onRefreshSession: options.onRefreshSession,
    });
    client.replayDurableDownstreamInbox();
    try {
      await client.wsClient.connect();
    } catch (error) {
      client.downstreamClosing = true;
      client.downstreamWorkerAbort.abort();
      client.attachmentMaterializer.abortAll();
      throw error;
    }
    if (client.shouldAutoFlushDurableOutbox()) {
      void client.requestDurableOutboxFlush(true);
    }
    return client;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.downstreamClosing = true;
    this.downstreamWorkerAbort.abort();
    this.attachmentMaterializer.abortAll();
    this.clearDurableOutboxTimer();
    await this.flushPendingUpstreamEvents({
      timeoutMs: 2_000,
      retryIntervalMs: 100,
    });
    this.closed = true;
    await this.wsClient.disconnect();
  }

  async flushPendingUpstreamEvents(
    options: FlushPendingUpstreamEventsOptions = {},
  ): Promise<{ flushed: boolean; remaining: number }> {
    const timeoutMs = Math.max(0, options.timeoutMs ?? 5_000);
    const retryIntervalMs = Math.max(10, options.retryIntervalMs ?? 250);
    const startedAt = Date.now();

    while (true) {
      await this.requestDurableOutboxFlush(true);
      const remaining = this.upstreamOutbox.load().length;
      if (remaining === 0) {
        return { flushed: true, remaining: 0 };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return { flushed: false, remaining };
      }
      await sleep(retryIntervalMs);
    }
  }

  async forceReconnect(reason = 'manual_reconnect'): Promise<void> {
    if (typeof this.wsClient.forceReconnect === 'function') {
      await this.wsClient.forceReconnect(reason);
      return;
    }
    await this.wsClient.disconnect();
    await this.wsClient.connect();
  }

  async createTaskSession(payload: Record<string, any>): Promise<Record<string, any>> {
    const projectId = String(payload.project_id || '').trim();
    if (!projectId) {
      throw new Error('project_id is required');
    }
    const title = String(payload.task_title || 'Untitled');
    const taskId = String(payload.task_id || safeRandomUuid());
    const explicitSessionId =
      typeof payload.session_id === 'string' && payload.session_id.trim()
        ? payload.session_id.trim()
        : null;
    const explicitSessionFilePath =
      typeof payload.session_file_path === 'string' && payload.session_file_path.trim()
        ? payload.session_file_path.trim()
        : typeof payload.sessionFilePath === 'string' && payload.sessionFilePath.trim()
          ? payload.sessionFilePath.trim()
          : null;
    const explicitDaemonName =
      typeof payload.daemon_name === 'string' && payload.daemon_name.trim()
        ? payload.daemon_name.trim()
        : typeof payload.daemonName === 'string' && payload.daemonName.trim()
          ? payload.daemonName.trim()
          : null;
    const backendType =
      typeof payload.backend_type === 'string'
        ? payload.backend_type
        : typeof payload.backendType === 'string'
          ? payload.backendType
          : undefined;
    const metadata =
      payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? { ...payload.metadata }
        : {};
    if (explicitDaemonName && metadata.daemonName === undefined) {
      metadata.daemonName = explicitDaemonName;
    }
    const logicalSessionId = explicitSessionId || taskId;

    await this.sessions.addSession(taskId, logicalSessionId, projectId);

    try {
      await this.backendApi.createTask({
        id: taskId,
        projectId,
        title,
        status: 'running',
        backendType,
        sessionId: logicalSessionId,
        sessionFilePath: explicitSessionFilePath,
        initialContent: typeof payload.prefill === 'string' ? payload.prefill : undefined,
        metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
        agentHost:
          typeof payload.agent_host === 'string'
            ? payload.agent_host
            : typeof payload.agentHost === 'string'
              ? payload.agentHost
              : this.agentHost,
      });
    } catch (error) {
      const limitMessage = getPlanLimitMessageFromError(error);
      if (limitMessage) {
        throw new Error(limitMessage, error instanceof Error ? { cause: error } : undefined);
      }
      throw error;
    }

    await this.waitForTaskCreation(projectId, taskId);
    this.promoteTaskDeliveryScope(taskId);

    const projectPath =
      typeof payload.project_path === 'string' && payload.project_path
        ? payload.project_path
        : this.projectPath;

    this.sessionStore.upsert({
      projectId,
      taskId,
      projectPath,
      sessionId: logicalSessionId,
      sessionFilePath: explicitSessionFilePath,
      backendType,
      hostname: this.resolveHostname(),
    });

    return {
      task_id: taskId,
      session_id: logicalSessionId,
      app_url: payload.app_url,
    };
  }

  async sendMessage(taskId: string, content: string, metadata?: Record<string, any>): Promise<Record<string, any>> {
    const messageId = safeRandomUuid();
    const result = await this.persistAndCommitUpstreamEvent({
      stableId: messageId,
      eventType: 'sdk_message',
      payload: {
        taskId,
        content,
        metadata,
        messageId,
      },
    });
    return { ...result, message_id: messageId };
  }

  async sendTaskStatus(taskId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    const statusEventId = safeRandomUuid();
    const result = await this.persistAndCommitUpstreamEvent({
      stableId: statusEventId,
      eventType: 'task_status_update',
      payload: {
        taskId,
        status: payload?.status,
        summary: payload?.summary,
        statusEventId,
      },
    });
    return { ...result, status_event_id: statusEventId };
  }

  async sendRuntimeStatus(taskId: string, payload: Record<string, any>): Promise<Record<string, any>> {
    await this.sendEnvelope({
      type: 'task_runtime_status',
      payload: {
        task_id: taskId,
        state: payload?.state,
        phase: payload?.phase,
        source: payload?.source,
        reply_in_progress: payload?.reply_in_progress,
        status_line: payload?.status_line,
        status_done_line: payload?.status_done_line,
        reply_preview: payload?.reply_preview,
        reply_to: payload?.reply_to,
        backend: payload?.backend,
        thread_id: payload?.thread_id,
        daemon: payload?.daemon,
        pid: payload?.pid,
        session_id: payload?.session_id,
        session_file_path: payload?.session_file_path,
        token_usage_percent: payload?.token_usage_percent,
        context_usage_percent: payload?.context_usage_percent,
        created_at: payload?.created_at,
      },
    });
    return { delivered: true };
  }

  async sendAgentResume(payload: {
    active_tasks?: string[];
    source?: string;
    metadata?: Record<string, any>;
    last_applied_cursor?: { created_at: string; request_id: string };
  } = {}): Promise<Record<string, any>> {
    const storedCursor = this.downstreamCursorStore.get(this.agentHost);
    const lastAppliedCursor = payload.last_applied_cursor ?? (
      storedCursor
        ? {
            created_at: storedCursor.createdAt,
            request_id: storedCursor.requestId,
          }
        : undefined
    );
    await this.sendEnvelope({
      type: 'agent_resume',
      payload: {
        active_tasks: Array.isArray(payload.active_tasks)
          ? payload.active_tasks.map((taskId) => String(taskId)).filter(Boolean)
          : [],
        source: payload.source,
        metadata: payload.metadata,
        last_applied_cursor: lastAppliedCursor,
      },
    });
    return { delivered: true };
  }

  async sendAgentCommandAck(payload: {
    request_id: string;
    task_id?: string;
    event_type?: string;
    accepted?: boolean;
  }): Promise<Record<string, any>> {
    const requestId = String(payload.request_id || '').trim();
    if (!requestId) {
      throw new Error('request_id is required');
    }
    
    const envelopePayload = {
      request_id: requestId,
      task_id: payload.task_id,
      event_type: payload.event_type,
      accepted: payload.accepted !== false,
    };

    const result = await this.persistAndCommitUpstreamEvent({
      stableId: requestId,
      eventType: 'agent_command_ack',
      payload: {
        requestId,
        taskId: envelopePayload.task_id,
        commandEventType: envelopePayload.event_type,
        accepted: envelopePayload.accepted,
      },
    });
    return { ...result, request_id: requestId };
  }

  async sendTaskStopAck(payload: { task_id: string; request_id: string; accepted?: boolean }): Promise<Record<string, any>> {
    const taskId = String(payload.task_id || '').trim();
    const requestId = String(payload.request_id || '').trim();
    if (!taskId) {
      throw new Error('task_id is required');
    }
    if (!requestId) {
      throw new Error('request_id is required');
    }
    const result = await this.persistAndCommitUpstreamEvent({
      stableId: requestId,
      eventType: 'task_stop_ack',
      payload: {
        taskId,
        requestId,
        accepted: payload.accepted !== false,
      },
    });
    return { ...result, request_id: requestId, task_id: taskId };
  }

  async receiveMessages(taskId: string, limit = 20): Promise<Record<string, any>> {
    const messages = await this.sessions.popMessages(taskId, limit);
    return formatMessagesResponse(messages);
  }

  async ackMessages(taskId: string, ackToken?: string | null): Promise<Record<string, any> | undefined> {
    if (!ackToken) {
      return undefined;
    }
    const success = await this.sessions.ack(taskId, ackToken);
    return { status: success ? 'ok' : 'ignored' };
  }

  async listProjects(): Promise<Record<string, any>> {
    const projects = await this.backendApi.listProjects();
    return {
      projects: projects.map((project: any) =>
        typeof project.asObject === 'function'
          ? project.asObject()
          : {
              id: project.id,
              name: project.name ?? null,
            },
      ),
    };
  }

  async createProject(name: string, metadata?: Record<string, unknown>): Promise<Record<string, any>>;
  async createProject(payload: Record<string, any>): Promise<Record<string, any>>;
  async createProject(
    nameOrPayload: string | Record<string, any>,
    metadata?: Record<string, unknown>,
  ): Promise<Record<string, any>> {
    const payload =
      typeof nameOrPayload === 'string'
        ? { name: nameOrPayload, metadata }
        : { ...nameOrPayload };
    const project = await this.backendApi.createProject(payload);
    return typeof (project as any).asObject === 'function' ? (project as any).asObject() : (project as any);
  }

  async listTasks(payload: Record<string, any> = {}): Promise<Record<string, any>> {
    const tasks = await this.backendApi.listTasks({
      projectId: payload.project_id ? String(payload.project_id) : undefined,
      status: payload.status ? String(payload.status) : undefined,
    });
    return {
      tasks: tasks.map((task: any) => ({
        id: task.id,
        project_id: task.project_id ?? task.projectId ?? null,
        title: task.title,
        status: task.status,
        backend_type: task.backend_type ?? task.backendType ?? null,
        session_id: task.session_id ?? task.sessionId ?? null,
        session_file_path: task.session_file_path ?? task.sessionFilePath ?? null,
        created_at: task.created_at ?? task.createdAt ?? null,
        updated_at: task.updated_at ?? task.updatedAt ?? null,
      })),
    };
  }

  async getTask(taskId: string): Promise<Record<string, any>> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('task_id is required');
    }
    const task = await this.backendApi.getTask(normalizedTaskId);
    return {
      id: task.id,
      project_id: task.projectId,
      title: task.title,
      status: task.status,
      backend_type: task.backendType ?? null,
      session_id: task.sessionId ?? null,
      session_file_path: task.sessionFilePath ?? null,
      created_at: task.createdAt ?? null,
      updated_at: task.updatedAt ?? null,
    };
  }

  async getLocalProjectRecord(payload: Record<string, any> = {}): Promise<Record<string, any>> {
    const projectPath =
      typeof payload.project_path === 'string' && payload.project_path
        ? payload.project_path
        : this.projectPath;
    const record = this.sessionStore.findByPath(projectPath);
    if (!record) {
      throw new Error(`No session record found for project path ${projectPath}`);
    }
    return {
      project_id: record.projectId,
      task_id: Array.from(record.taskIds),
      session_id: record.sessionId,
      hostname: record.hostname,
    };
  }

  async getLocalTaskRecord(payload: Record<string, any> = {}): Promise<Record<string, any>> {
    const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
    if (!taskId) {
      throw new Error('task_id is required');
    }
    const record = this.sessionStore.findByTaskId(taskId);
    if (!record) {
      throw new Error(`No session record found for task ${taskId}`);
    }
    return {
      project_id: record.projectId,
      task_id: taskId,
      task_ids: Array.from(record.taskIds),
      project_path: record.projectPath,
      session_id: record.sessionId ?? null,
      session_file_path: record.sessionFilePath ?? null,
      backend_type: record.backendType ?? null,
      hostname: record.hostname,
    };
  }

  async bindTaskSession(taskId: string, payload: Record<string, any> = {}): Promise<Record<string, any>> {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      throw new Error('task_id is required');
    }
    this.promoteTaskDeliveryScope(normalizedTaskId);
    const explicitDaemonName =
      typeof payload.daemon_name === 'string' && payload.daemon_name.trim()
        ? payload.daemon_name.trim()
        : typeof payload.daemonName === 'string' && payload.daemonName.trim()
          ? payload.daemonName.trim()
          : null;

    const existing = this.sessionStore.findByTaskId(normalizedTaskId);
    const inMemorySession = await this.sessions.getSession(normalizedTaskId);
    const projectId =
      existing?.projectId ||
      inMemorySession?.projectId ||
      (typeof payload.project_id === 'string' && payload.project_id.trim() ? payload.project_id.trim() : 'unknown-project');
    const projectPath =
      existing?.projectPath ||
      (typeof payload.project_path === 'string' && payload.project_path
        ? payload.project_path
        : this.projectPath);

    const record = this.sessionStore.upsert({
      projectId,
      taskId: normalizedTaskId,
      projectPath,
      sessionId:
        typeof payload.session_id === 'string'
          ? payload.session_id
          : payload.session_id === null
            ? null
            : existing?.sessionId ?? null,
      sessionFilePath:
        typeof payload.session_file_path === 'string'
          ? payload.session_file_path
          : payload.session_file_path === null
            ? null
            : existing?.sessionFilePath ?? null,
      backendType:
        typeof payload.backend_type === 'string'
          ? payload.backend_type
          : payload.backend_type === null
            ? null
            : existing?.backendType ?? null,
      hostname:
        typeof payload.hostname === 'string'
          ? payload.hostname
          : existing?.hostname ?? this.resolveHostname(),
    });

    if (typeof (this.backendApi as any).updateTask === 'function') {
      await this.backendApi.updateTask(normalizedTaskId, {
        backendType: record.backendType ?? null,
        sessionId: record.sessionId ?? null,
        sessionFilePath: record.sessionFilePath ?? null,
        metadata: explicitDaemonName ? { daemonName: explicitDaemonName } : undefined,
      });
    }

    return {
      project_id: record.projectId,
      task_id: normalizedTaskId,
      session_id: record.sessionId ?? null,
      session_file_path: record.sessionFilePath ?? null,
      backend_type: record.backendType ?? null,
      project_path: record.projectPath,
      hostname: record.hostname,
    };
  }

  async matchProjectByPath(payload: Record<string, any> = {}): Promise<Record<string, any>> {
    const daemonHost =
      (typeof payload.daemon_host === 'string' && payload.daemon_host.trim()) ||
      (typeof payload.daemonHost === 'string' && payload.daemonHost.trim()) ||
      (typeof payload.hostname === 'string' && payload.hostname.trim()) ||
      this.agentHost;
    const projectPath = resolveWorkspacePath(
      typeof payload.project_path === 'string' && payload.project_path
        ? payload.project_path
        : typeof payload.projectPath === 'string' && payload.projectPath
          ? payload.projectPath
          : this.projectPath,
    );
    if (!projectPath) {
      throw new Error('project_path is required');
    }
    const result = await this.backendApi.matchProjectByPath({
      daemon_host: daemonHost,
      path: projectPath,
    });
    if (result.project) {
      return {
        project_id: result.project.id,
        project_name: result.project.name,
        matched_path: result.matchedPath,
      };
    }
    return {
      project_id: null,
      project_name: null,
      matched_path: null,
    };
  }

  async bindProjectPath(projectId: string, payload: Record<string, any> = {}): Promise<Record<string, any>> {
    if (!projectId) {
      throw new Error('project_id is required');
    }
    const daemonHost =
      (typeof payload.daemon_host === 'string' && payload.daemon_host.trim()) ||
      (typeof payload.daemonHost === 'string' && payload.daemonHost.trim()) ||
      (typeof payload.hostname === 'string' && payload.hostname.trim()) ||
      this.agentHost;
    const projectPath = resolveWorkspacePath(
      typeof payload.project_path === 'string' && payload.project_path
        ? payload.project_path
        : typeof payload.projectPath === 'string' && payload.projectPath
          ? payload.projectPath
          : this.projectPath,
    );
    const snapshot = resolveWorkspaceSnapshot(projectPath);
    const boundProject = await this.backendApi.updateProject(projectId, {
      bindingConfirmed: true,
      daemonHost,
      workspacePath: snapshot.projectRoot,
      repoRoot: snapshot.repoRoot,
      worktreeBranch: snapshot.worktreeBranch,
      lastCommit: snapshot.lastCommit,
      lastCommitAt: snapshot.lastCommitAt,
      fileCount: snapshot.fileCount,
    });
    return {
      success: true,
      project_id: boundProject.id,
      project_name: boundProject.name ?? null,
      hostname: daemonHost,
      daemon_host: daemonHost,
      path: snapshot.projectRoot,
      repo_root: snapshot.repoRoot ?? null,
      worktree_branch: snapshot.worktreeBranch ?? null,
      last_commit: snapshot.lastCommit ?? null,
      last_commit_at: snapshot.lastCommitAt ?? null,
      file_count: snapshot.fileCount ?? null,
    };
  }

  private readonly handleBackendEvent: WebSocketHandler = async (payload) => {
    if (typeof payload?.type === 'string' && payload.type === 'refresh_session') {
      void this.handleRefreshSessionCommand(payload).catch((error) => {
        const data =
          payload?.payload && typeof payload.payload === 'object'
            ? (payload.payload as Record<string, any>)
            : null;
        const taskId = typeof data?.task_id === 'string' ? data.task_id.trim() : '';
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `[sdk] refresh_session dispatch failed${taskId ? ` for task ${taskId}` : ''}: ${message}`,
        );
      });
      return;
    }

    if (typeof payload?.type === 'string' && payload.type === 'interrupt_turn') {
      await this.handleInterruptTurnCommand(payload);
      return;
    }

    const command = this.extractDownstreamCommandContext(payload);
    if (command?.eventType === 'stop_task') {
      this.cancelledDownstreamTasks.add(command.taskId);
      await this.handleStopTaskCommand(payload, command);
      return;
    }

    const alreadyApplied = command ? this.downstreamCursorStore.hasApplied(this.agentHost, command.cursor) : false;
    if (!alreadyApplied) {
      if (command && this.attachmentMaterializer.validateEnvelopeForStaging(payload)) {
        const durable = this.downstreamInboxStore.upsert({
          requestId: command.requestId,
          taskId: command.taskId,
          cursor: command.cursor,
          envelope: payload,
        });
        this.enqueueDurableDownstreamCommand(durable);
        await this.maybeAckInboundCommand(payload, { accepted: true });
        return;
      }
      if (command) {
        await this.downstreamTasks.get(command.taskId);
      }
      const materializedPayload = await this.attachmentMaterializer.materializeEnvelope(payload);
      await this.messageRouter.handleBackendEvent(materializedPayload);
      if (command) {
        this.downstreamCursorStore.advance(this.agentHost, command.cursor);
      }
    }

    await this.maybeAckInboundCommand(payload, {
      accepted: true,
    });
  }

  private replayDurableDownstreamInbox(): void {
    const entries = this.downstreamInboxStore.list().sort((left, right) => {
      const byTime = Date.parse(left.cursor.createdAt) - Date.parse(right.cursor.createdAt);
      return byTime || left.cursor.requestId.localeCompare(right.cursor.requestId);
    });
    for (const entry of entries) this.enqueueDurableDownstreamCommand(entry);
  }

  private enqueueDurableDownstreamCommand(entry: DurableDownstreamCommand): void {
    if (this.queuedDownstreamRequests.has(entry.requestId)) return;
    this.queuedDownstreamRequests.add(entry.requestId);
    const previous = this.downstreamTasks.get(entry.taskId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      let attempt = entry.attemptCount;
      while (!this.closed && !this.downstreamClosing) {
        if (this.cancelledDownstreamTasks.has(entry.taskId)) {
          this.downstreamInboxStore.remove(entry.requestId);
          return;
        }
        const nextAttemptMs = Date.parse(entry.nextAttemptAt);
        if (Number.isFinite(nextAttemptMs) && nextAttemptMs > Date.now()) {
          await sleepWithSignal(nextAttemptMs - Date.now(), this.downstreamWorkerAbort.signal);
        }
        try {
          const materialized = await this.attachmentMaterializer.materializeEnvelope(entry.envelope);
          if (this.cancelledDownstreamTasks.has(entry.taskId)) {
            this.downstreamInboxStore.remove(entry.requestId);
            return;
          }
          // A shutdown after download must leave the already-ACKed command in
          // the durable inbox so the next process can route it. Removing it
          // here would make the Web outbox and the Daemon both forget it.
          if (this.closed || this.downstreamClosing) return;
          await this.messageRouter.handleBackendEvent(materialized);
          this.downstreamCursorStore.advance(this.agentHost, entry.cursor);
          this.downstreamInboxStore.remove(entry.requestId);
          return;
        } catch (error) {
          if ((error as { permanent?: boolean } | null)?.permanent) {
            const reported = await this.reportUnrecoverableAttachmentCommand(entry, error);
            // Only drop the command once the user-facing explanation is durably
            // queued; otherwise keep retrying so the failure cannot vanish.
            if (reported) {
              this.downstreamCursorStore.advance(this.agentHost, entry.cursor);
              this.downstreamInboxStore.remove(entry.requestId);
              return;
            }
          }
          attempt += 1;
          const delayMs = Math.min(1_000 * (2 ** Math.min(attempt, 5)), 30_000);
          try {
            this.downstreamInboxStore.markRetry(entry.requestId, delayMs);
          } catch (persistError) {
            console.warn(`[sdk] failed to persist downstream retry state for ${entry.requestId}: ${persistError instanceof Error ? persistError.message : String(persistError)}`);
          }
          console.warn(`[sdk] downstream attachment command ${entry.requestId} failed; retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`);
          await sleepWithSignal(delayMs, this.downstreamWorkerAbort.signal);
        }
      }
    }).catch((error) => {
      console.warn(`[sdk] downstream worker ${entry.requestId} stopped unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.queuedDownstreamRequests.delete(entry.requestId);
      if (this.downstreamTasks.get(entry.taskId) === current) this.downstreamTasks.delete(entry.taskId);
    });
    this.downstreamTasks.set(entry.taskId, current);
  }

  /**
   * Tell the user why an attachment message will never run. Silently dropping
   * it would leave a question in the chat that never gets an answer.
   */
  private async reportUnrecoverableAttachmentCommand(
    entry: DurableDownstreamCommand,
    error: unknown,
  ): Promise<boolean> {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await this.sendMessage(
        entry.taskId,
        `The attachments on this message are no longer available, so it could not be processed (${reason}). Please send them again.`,
        { attachment_delivery: 'failed', reply_to: entry.requestId },
      );
      return true;
    } catch (reportError) {
      console.warn(
        `[sdk] failed to report unrecoverable attachment command ${entry.requestId}: ${reportError instanceof Error ? reportError.message : String(reportError)}`,
      );
      return false;
    }
  }

  private extractDownstreamCommandContext(payload: BackendEnvelope): {
    eventType: 'task_user_message' | 'task_action' | 'stop_task';
    taskId: string;
    requestId: string;
    cursor: DownstreamCommandCursor;
  } | null {
    const eventType = typeof payload?.type === 'string' ? payload.type : '';
    if (eventType !== 'task_user_message' && eventType !== 'task_action' && eventType !== 'stop_task') {
      return null;
    }
    const data =
      payload?.payload && typeof payload.payload === 'object'
        ? (payload.payload as Record<string, any>)
        : null;
    if (!data) {
      return null;
    }
    const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : '';
    const requestId = typeof data.request_id === 'string' ? data.request_id.trim() : '';
    const cursor = normalizeDownstreamCommandCursor(data.delivery_cursor);
    if (!taskId || !requestId || !cursor) {
      return null;
    }
    return {
      eventType,
      taskId,
      requestId,
      cursor,
    };
  }

  private async handleStopTaskCommand(
    payload: BackendEnvelope,
    command: {
      taskId: string;
      requestId: string;
      cursor: DownstreamCommandCursor;
    },
  ): Promise<void> {
    const alreadyApplied = this.downstreamCursorStore.hasApplied(this.agentHost, command.cursor);
    let accepted = false;

    if (alreadyApplied) {
      accepted = true;
    } else {
      accepted = await this.invokeStopTaskHandler(payload);
      if (accepted) {
        this.downstreamCursorStore.advance(this.agentHost, command.cursor);
      }
    }

    if (!command.requestId) {
      return;
    }

    try {
      await this.sendTaskStopAck({
        task_id: command.taskId,
        request_id: command.requestId,
        accepted,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sdk] failed to send task_stop_ack for task ${command.taskId}: ${message}`);
    }
  }

  private async invokeStopTaskHandler(payload: BackendEnvelope): Promise<boolean> {
    const data =
      payload?.payload && typeof payload.payload === 'object'
        ? (payload.payload as Record<string, any>)
        : null;
    if (!data) {
      return false;
    }

    const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : '';
    const requestId = typeof data.request_id === 'string' ? data.request_id.trim() : '';
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    if (!taskId) {
      return false;
    }

    if (!this.onStopTask) {
      return false;
    }

    try {
      await this.onStopTask({
        taskId,
        requestId: requestId || undefined,
        reason: reason || undefined,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sdk] stop_task callback failed for task ${taskId}: ${message}`);
      return false;
    }
  }

  private async handleInterruptTurnCommand(payload: BackendEnvelope): Promise<void> {
    const accepted = await this.invokeInterruptTurnHandler(payload);
    await this.maybeAckInboundCommand(payload, { accepted });
  }

  private async handleRefreshSessionCommand(payload: BackendEnvelope): Promise<void> {
    const accepted = await this.invokeRefreshSessionHandler(payload);
    await this.maybeAckInboundCommand(payload, { accepted });
  }

  private async invokeInterruptTurnHandler(payload: BackendEnvelope): Promise<boolean> {
    const data =
      payload?.payload && typeof payload.payload === 'object'
        ? (payload.payload as Record<string, any>)
        : null;
    if (!data) {
      return false;
    }

    const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : '';
    const requestId = typeof data.request_id === 'string' ? data.request_id.trim() : '';
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    const targetReplyTo =
      typeof data.target_reply_to === 'string'
        ? data.target_reply_to.trim()
        : typeof data.targetReplyTo === 'string'
          ? data.targetReplyTo.trim()
          : '';
    if (!taskId || !targetReplyTo) {
      return false;
    }

    if (!this.onInterruptTurn) {
      return false;
    }

    try {
      const accepted = await this.onInterruptTurn({
        taskId,
        requestId: requestId || undefined,
        reason: reason || undefined,
        targetReplyTo,
      });
      return accepted !== false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sdk] interrupt_turn callback failed for task ${taskId}: ${message}`);
      return false;
    }
  }

  private async invokeRefreshSessionHandler(payload: BackendEnvelope): Promise<boolean> {
    const data =
      payload?.payload && typeof payload.payload === 'object'
        ? (payload.payload as Record<string, any>)
        : null;
    if (!data) {
      return false;
    }

    const taskId = typeof data.task_id === 'string' ? data.task_id.trim() : '';
    const requestId = typeof data.request_id === 'string' ? data.request_id.trim() : '';
    const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
    const sessionId =
      typeof data.session_id === 'string'
        ? data.session_id.trim()
        : typeof data.sessionId === 'string'
          ? data.sessionId.trim()
          : '';
    const sessionFilePath =
      typeof data.session_file_path === 'string'
        ? data.session_file_path.trim()
        : typeof data.sessionFilePath === 'string'
          ? data.sessionFilePath.trim()
          : '';
    if (!taskId || !sessionId) {
      return false;
    }

    if (!this.onRefreshSession) {
      return false;
    }

    try {
      const accepted = await this.onRefreshSession({
        taskId,
        requestId: requestId || undefined,
        reason: reason || undefined,
        sessionId,
        sessionFilePath: sessionFilePath || undefined,
      });
      return accepted !== false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sdk] refresh_session callback failed for task ${taskId}: ${message}`);
      return false;
    }
  }

  private async persistAndCommitUpstreamEvent(entry: {
    stableId: string;
    eventType: DurableUpstreamEventType;
    payload: Record<string, unknown>;
  }): Promise<{ delivered: boolean; pending?: boolean }> {
    const stored = this.upstreamOutbox.upsert(entry);
    if (stored.eventType === 'sdk_message' && this.hasEarlierPendingSdkMessage(stored.stableId)) {
      this.scheduleDurableOutboxFlush(0);
      return { delivered: false, pending: true };
    }
    try {
      await this.commitDurableUpstreamEvent(stored);
      this.upstreamOutbox.remove(stored.stableId);
      return { delivered: true };
    } catch (error) {
      if (!this.isRetryableUpstreamError(error)) {
        this.upstreamOutbox.remove(stored.stableId);
        throw error;
      }
      const updated = this.upstreamOutbox.markRetry(
        stored.stableId,
        this.computeDurableOutboxRetryDelay(stored.attemptCount + 1),
      );
      const delay = updated?.nextAttemptAt
        ? Math.max(Date.parse(updated.nextAttemptAt) - Date.now(), 0)
        : this.computeDurableOutboxRetryDelay(stored.attemptCount + 1);
      console.warn(
        `[sdk] queued ${stored.eventType} (${stored.stableId}) for durable retry after HTTP failure: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.scheduleDurableOutboxFlush(delay);
      return { delivered: false, pending: true };
    }
  }

  private async requestDurableOutboxFlush(force = false): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.durableOutboxFlushPromise) {
      return this.durableOutboxFlushPromise;
    }
    this.durableOutboxFlushPromise = (async () => {
      const readyEntries = force ? this.upstreamOutbox.load() : this.upstreamOutbox.listReady();
      let sdkMessageBlocked = false;
      for (const entry of readyEntries) {
        if (this.closed) {
          break;
        }
        if (sdkMessageBlocked && entry.eventType === 'sdk_message') {
          continue;
        }
        try {
          await this.commitDurableUpstreamEvent(entry);
          this.upstreamOutbox.remove(entry.stableId);
        } catch (error) {
          if (!this.isRetryableUpstreamError(error)) {
            this.upstreamOutbox.remove(entry.stableId);
            console.warn(
              `[sdk] dropping durable upstream event ${entry.eventType} (${entry.stableId}) after terminal HTTP failure: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
          const updated = this.upstreamOutbox.markRetry(
            entry.stableId,
            this.computeDurableOutboxRetryDelay(entry.attemptCount + 1),
          );
          console.warn(
            `[sdk] durable retry failed for ${entry.eventType} (${entry.stableId}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (entry.eventType === 'sdk_message') {
            sdkMessageBlocked = true;
          }
          if (updated?.nextAttemptAt) {
            this.scheduleDurableOutboxFlush(Math.max(Date.parse(updated.nextAttemptAt) - Date.now(), 0));
          }
        }
      }
      const nextDelay = this.upstreamOutbox.nextRetryDelay();
      if (nextDelay !== null) {
        this.scheduleDurableOutboxFlush(nextDelay);
      }
    })().finally(() => {
      this.durableOutboxFlushPromise = null;
    });
    return this.durableOutboxFlushPromise;
  }

  private hasEarlierPendingSdkMessage(stableId: string): boolean {
    const entries = this.upstreamOutbox.load();
    const currentIndex = entries.findIndex((candidate) => candidate.stableId === stableId);
    if (currentIndex <= 0) {
      return false;
    }
    return entries.slice(0, currentIndex).some((candidate) => candidate.eventType === 'sdk_message');
  }

  private async commitDurableUpstreamEvent(entry: DurableUpstreamEvent): Promise<void> {
    if (entry.eventType === 'sdk_message') {
      await this.backendApi.commitSdkMessage({
        agentHost: this.agentHost,
        taskId: String(entry.payload.taskId || ''),
        content: String(entry.payload.content || ''),
        metadata:
          entry.payload.metadata && typeof entry.payload.metadata === 'object' && !Array.isArray(entry.payload.metadata)
            ? (entry.payload.metadata as Record<string, unknown>)
            : undefined,
        messageId: entry.payload.messageId ? String(entry.payload.messageId) : null,
      });
      return;
    }
    if (entry.eventType === 'task_status_update') {
      await this.backendApi.commitTaskStatusUpdate({
        agentHost: this.agentHost,
        taskId: String(entry.payload.taskId || ''),
        status: String(entry.payload.status || ''),
        summary: entry.payload.summary ? String(entry.payload.summary) : null,
        statusEventId: entry.payload.statusEventId ? String(entry.payload.statusEventId) : null,
      });
      return;
    }
    if (entry.eventType === 'task_stop_ack') {
      await this.backendApi.commitTaskStopAck({
        agentHost: this.agentHost,
        taskId: String(entry.payload.taskId || ''),
        requestId: String(entry.payload.requestId || ''),
        accepted: entry.payload.accepted !== false,
      });
      return;
    }
    await this.backendApi.commitAgentCommandAck({
      agentHost: this.agentHost,
      requestId: String(entry.payload.requestId || ''),
      taskId: entry.payload.taskId ? String(entry.payload.taskId) : null,
      accepted: entry.payload.accepted !== false,
      commandEventType: entry.payload.commandEventType ? String(entry.payload.commandEventType) : null,
    });
  }

  private isRetryableUpstreamError(error: unknown): boolean {
    if (!(error instanceof BackendApiError)) {
      return true;
    }
    if (error.statusCode === undefined || error.statusCode === null) {
      return true;
    }
    if (error.statusCode >= 500) {
      return true;
    }
    return error.statusCode === 408 || error.statusCode === 429;
  }

  private computeDurableOutboxRetryDelay(attemptCount: number): number {
    const cappedExponent = Math.max(0, Math.min(attemptCount - 1, 5));
    return 1_000 * 2 ** cappedExponent;
  }

  private scheduleDurableOutboxFlush(delayMs: number): void {
    if (this.closed) {
      return;
    }
    const normalizedDelay = Math.max(delayMs, 0);
    const dueAt = Date.now() + normalizedDelay;
    if (
      this.durableOutboxTimer &&
      this.durableOutboxTimerDueAt !== null &&
      this.durableOutboxTimerDueAt <= dueAt
    ) {
      return;
    }
    this.clearDurableOutboxTimer();
    this.durableOutboxTimerDueAt = dueAt;
    this.durableOutboxTimer = setTimeout(() => {
      this.durableOutboxTimer = null;
      this.durableOutboxTimerDueAt = null;
      void this.requestDurableOutboxFlush(false);
    }, normalizedDelay);
  }

  clearDurableOutboxTimer(): void {
    if (this.durableOutboxTimer) {
      clearTimeout(this.durableOutboxTimer);
      this.durableOutboxTimer = null;
    }
    this.durableOutboxTimerDueAt = null;
  }

  private async sendEnvelope(envelope: BackendEnvelope): Promise<void> {
    await this.wsClient.sendJson(envelope);
  }

  private async maybeAckInboundCommand(
    payload: BackendEnvelope,
    options: { accepted?: boolean } = {},
  ): Promise<void> {
    const eventType = typeof payload?.type === 'string' ? payload.type : '';
    if (
      eventType !== 'task_user_message' &&
      eventType !== 'task_action' &&
      eventType !== 'interrupt_turn' &&
      eventType !== 'refresh_session'
    ) {
      return;
    }
    const data =
      payload?.payload && typeof payload.payload === 'object'
        ? (payload.payload as Record<string, any>)
        : null;
    if (!data) {
      return;
    }
    const requestId = typeof data.request_id === 'string' ? data.request_id.trim() : '';
    if (!requestId) {
      return;
    }
    try {
      await this.sendAgentCommandAck({
        request_id: requestId,
        task_id: typeof data.task_id === 'string' ? data.task_id : undefined,
        event_type: eventType,
        accepted: typeof options.accepted === 'boolean' ? options.accepted : true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[sdk] failed to ack inbound command ${requestId}: ${message}`);
    }
  }

  private promoteTaskDeliveryScope(taskId: string): void {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      return;
    }
    this.setDeliveryScopeId(`task:${normalizedTaskId}`);
  }

  private setDeliveryScopeId(scopeId: string): void {
    const nextScopeId = normalizeDeliveryScopeId(scopeId);
    if (nextScopeId === this.deliveryScopeId) {
      return;
    }

    const currentUpstream = this.upstreamOutbox;
    const currentCursorStore = this.downstreamCursorStore;
    const currentInboxStore = this.downstreamInboxStore;
    const nextUpstream = DurableUpstreamOutboxStore.forProjectPath(this.projectPath, nextScopeId);
    const nextCursorStore = DownstreamCursorStore.forProjectPath(this.projectPath, nextScopeId);
    const nextInboxStore = DownstreamInboxStore.forProjectPath(this.projectPath, nextScopeId);

    for (const entry of currentUpstream.load()) {
      nextUpstream.upsert({
        stableId: entry.stableId,
        eventType: entry.eventType,
        payload: entry.payload,
      });
      currentUpstream.remove(entry.stableId);
    }

    const currentCursor = currentCursorStore.get(this.agentHost);
    if (currentCursor) {
      nextCursorStore.advance(this.agentHost, currentCursor);
    }
    for (const entry of currentInboxStore.list()) {
      nextInboxStore.import(entry);
      currentInboxStore.remove(entry.requestId);
    }

    this.upstreamOutbox = nextUpstream;
    this.downstreamCursorStore = nextCursorStore;
    this.downstreamInboxStore = nextInboxStore;
    this.deliveryScopeId = nextScopeId;
    void this.requestDurableOutboxFlush(true);
  }

  private shouldAutoFlushDurableOutbox(): boolean {
    return this.deliveryScopeId.startsWith('task:') || this.deliveryScopeId.startsWith('session:');
  }

  private resolveHostname(): string {
    const records = this.sessionStore.load();
    for (const record of records) {
      if (record.hostname) {
        return record.hostname;
      }
    }
    return currentHostname();
  }

  private async waitForTaskCreation(projectId: string, taskId: string): Promise<void> {
    const retries = this.readIntEnv('CONDUCTOR_TASK_CREATE_RETRIES', 10);
    if (retries <= 0) {
      return;
    }
    const delayMs = this.readIntEnv('CONDUCTOR_TASK_CREATE_DELAY_MS', 250);
    for (let attempt = 0; attempt < retries; attempt += 1) {
      try {
        const tasks = await this.backendApi.listTasks({ projectId });
        if (tasks.some((task: any) => String(task?.id || '') === taskId)) {
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[sdk] createTaskSession unable to confirm task ${taskId}: ${message}`);
        return;
      }
      if (attempt < retries - 1) {
        await sleep(delayMs);
      }
    }
    console.warn(`[sdk] createTaskSession timed out waiting for task ${taskId}`);
  }

  private readIntEnv(key: string, fallback: number): number {
    const raw = this.env[key];
    if (!raw) {
      return fallback;
    }
    const value = parseInt(raw, 10);
    return Number.isFinite(value) ? value : fallback;
  }
}

function formatMessagesResponse(
  messages: Array<{
    messageId: string;
    role: string;
    content: string;
    ackToken?: string | null;
    createdAt: Date;
    metadata?: Record<string, unknown> | null;
    attachments?: Array<Record<string, unknown>>;
  }>,
) {
  return {
    messages: messages.map((msg) => ({
      message_id: msg.messageId,
      role: msg.role,
      content: msg.content,
      ack_token: msg.ackToken,
      metadata: msg.metadata ?? undefined,
      attachments: msg.attachments?.length ? msg.attachments : undefined,
      created_at: msg.createdAt.toISOString(),
    })),
    next_ack_token: messages.length ? messages[messages.length - 1].ackToken ?? null : null,
    has_more: false,
  };
}

function safeRandomUuid(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function resolveAgentHost(env: Record<string, string | undefined>, explicit?: string): string {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const fromAgent = env.CONDUCTOR_AGENT_NAME;
  if (typeof fromAgent === 'string' && fromAgent.trim()) {
    return fromAgent.trim();
  }
  // CONDUCTOR_DAEMON_NAME is inherited from the daemon that spawned this fire,
  // so it names the daemon, not this process. Returning it verbatim would make
  // the fire impersonate its own daemon: same identity on the hub (mutual
  // eviction) and no `conductor-fire-` prefix (wrong plan bucket, eligible for
  // daemon task routing). Use it as the owner segment instead.
  return buildFireHostName(env);
}

function normalizeDeliveryScopeId(scopeId: string): string {
  const normalized = String(scopeId || '').trim();
  return normalized || 'default';
}

function resolveWorkspacePath(candidate: string): string {
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  if (!trimmed) {
    return '';
  }
  try {
    return fs.realpathSync(trimmed);
  } catch {
    return path.resolve(trimmed);
  }
}

function resolveWorkspaceSnapshot(projectPath: string): ReturnType<ProjectContext['snapshot']> {
  try {
    const context = new ProjectContext(projectPath);
    return context.snapshot();
  } catch {
    return {
      projectRoot: resolveWorkspacePath(projectPath),
    };
  }
}

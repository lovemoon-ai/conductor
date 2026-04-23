import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BackendApiError } from '../src/backend/index.js';
import { ConductorClient } from '../src/client.js';
import { ConductorConfig } from '../src/config/index.js';
import { DurableUpstreamOutboxStore } from '../src/outbox/index.js';
import { SessionDiskStore } from '../src/session/index.js';

function makeConfig(): ConductorConfig {
  return new ConductorConfig({
    agentToken: 'token',
    backendUrl: 'https://backend.local',
  });
}

class FakeBackendApi {
  projects: Array<{
    id: string;
    name?: string;
    metadata?: Record<string, unknown>;
    daemonHost?: string;
    workspacePath?: string;
    repoRoot?: string;
    worktreeBranch?: string;
    lastCommit?: string;
    fileCount?: number;
  }> = [];
  tasks: Array<{
    id: string;
    project_id: string;
    title: string;
    status: string;
    backend_type?: string | null;
    session_id?: string | null;
    session_file_path?: string | null;
  }> = [];
  createTaskCalls: Array<{
    id: string;
    projectId: string;
    title: string;
    status?: string;
    backendType?: string;
    sessionId?: string | null;
    sessionFilePath?: string | null;
    initialContent?: string;
    agentHost?: string;
    metadata?: Record<string, unknown>;
  }> = [];
  updateTaskCalls: Array<{
    taskId: string;
    backendType?: string | null;
    sessionId?: string | null;
    sessionFilePath?: string | null;
    metadata?: Record<string, unknown>;
  }> = [];
  getTaskCalls: string[] = [];
  commitSdkMessageCalls: Array<{
    agentHost: string;
    taskId: string;
    content: string;
    metadata?: Record<string, unknown>;
    messageId?: string | null;
  }> = [];
  commitTaskStatusCalls: Array<{
    agentHost: string;
    taskId: string;
    status: string;
    summary?: string | null;
    statusEventId?: string | null;
  }> = [];
  commitAgentCommandAckCalls: Array<{
    agentHost: string;
    requestId: string;
    taskId?: string | null;
    accepted?: boolean;
    commandEventType?: string | null;
  }> = [];
  commitTaskStopAckCalls: Array<{
    agentHost: string;
    taskId: string;
    requestId: string;
    accepted?: boolean;
  }> = [];

  async listProjects() {
    return this.projects.map((project) => ({
      ...project,
      asObject() {
        return {
          id: project.id,
          name: project.name,
        };
      },
    }));
  }

  async createProject(params: {
    name?: string;
    metadata?: Record<string, unknown>;
    daemonHost?: string;
    workspacePath?: string;
    repoRoot?: string;
    worktreeBranch?: string;
    lastCommit?: string;
    fileCount?: number;
  }) {
    const project = {
      id: `p-${this.projects.length + 1}`,
      name: params.name,
      metadata: params.metadata,
      daemonHost: params.daemonHost,
      workspacePath: params.workspacePath,
      repoRoot: params.repoRoot,
      worktreeBranch: params.worktreeBranch,
      lastCommit: params.lastCommit,
      fileCount: params.fileCount,
      asObject() {
        return {
          id: project.id,
          name: project.name,
        };
      },
    };
    this.projects.push(project);
    return project;
  }

  async listTasks({ projectId, status }: { projectId?: string; status?: string } = {}) {
    return this.tasks.filter((task) => {
      if (projectId && task.project_id !== projectId) return false;
      if (status && task.status !== status) return false;
      return true;
    });
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
  }) {
    this.createTaskCalls.push({
      id: params.id || '',
      projectId: params.projectId,
      title: params.title,
      status: params.status,
      backendType: params.backendType,
      sessionId: params.sessionId,
      sessionFilePath: params.sessionFilePath,
      initialContent: params.initialContent,
      agentHost: params.agentHost,
      metadata: params.metadata,
    });
    this.tasks.push({
      id: params.id || `t-${this.tasks.length + 1}`,
      project_id: params.projectId,
      title: params.title,
      status: params.status || 'CREATED',
      backend_type: params.backendType ?? null,
      session_id: params.sessionId ?? null,
      session_file_path: params.sessionFilePath ?? null,
    });
    return {
      id: params.id || `t-${this.tasks.length + 1}`,
      projectId: params.projectId,
      title: params.title,
      status: params.status || 'CREATED',
      backend_type: params.backendType ?? null,
      session_id: params.sessionId ?? null,
      session_file_path: params.sessionFilePath ?? null,
    };
  }

  async getTask(taskId: string) {
    this.getTaskCalls.push(taskId);
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new BackendApiError('Backend responded with 404', 404, { error: 'Not found' });
    }
    return {
      id: task.id,
      projectId: task.project_id,
      title: task.title,
      status: task.status,
      backendType: task.backend_type ?? null,
      sessionId: task.session_id ?? null,
      sessionFilePath: task.session_file_path ?? null,
      createdAt: null,
      updatedAt: null,
    };
  }

  async updateTask(
    taskId: string,
    params: {
      backendType?: string | null;
      sessionId?: string | null;
      sessionFilePath?: string | null;
      metadata?: Record<string, unknown>;
    },
  ) {
    this.updateTaskCalls.push({
      taskId,
      backendType: params.backendType,
      sessionId: params.sessionId,
      sessionFilePath: params.sessionFilePath,
      metadata: params.metadata,
    });
    const task = this.tasks.find((entry) => entry.id === taskId);
    if (task) {
      task.backend_type = params.backendType ?? task.backend_type ?? null;
      task.session_id = params.sessionId ?? task.session_id ?? null;
      task.session_file_path = params.sessionFilePath ?? task.session_file_path ?? null;
      return task;
    }
    return {
      id: taskId,
      project_id: 'unknown',
      title: 'Unknown',
      status: 'unknown',
      backend_type: params.backendType ?? null,
      session_id: params.sessionId ?? null,
      session_file_path: params.sessionFilePath ?? null,
    };
  }

  async matchProjectByPath(params: { hostname?: string; daemonHost?: string; daemon_host?: string; path: string }) {
    const project = this.projects[0] || null;
    return {
      project: project
        ? {
            id: project.id,
            name: project.name,
          }
        : null,
      matchedPath: project ? params.path : null,
    };
  }

  async getProject(projectId: string) {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`project not found: ${projectId}`);
    }
    return project;
  }

  async updateProject(projectId: string, params: {
    metadata?: Record<string, unknown>;
    daemonHost?: string;
    workspacePath?: string;
    repoRoot?: string;
    worktreeBranch?: string;
    lastCommit?: string;
    fileCount?: number;
  }) {
    const project = this.projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error(`project not found: ${projectId}`);
    }
    project.metadata = params.metadata;
    if (params.daemonHost) project.daemonHost = params.daemonHost;
    if (params.workspacePath) project.workspacePath = params.workspacePath;
    if (params.repoRoot) project.repoRoot = params.repoRoot;
    if (params.worktreeBranch) project.worktreeBranch = params.worktreeBranch;
    if (params.lastCommit) project.lastCommit = params.lastCommit;
    if (typeof params.fileCount === 'number') project.fileCount = params.fileCount;
    return {
      id: project.id,
      name: project.name,
      asObject() {
        return {
          id: project.id,
          name: project.name,
        };
      },
    };
  }

  async commitSdkMessage(params: {
    agentHost: string;
    taskId: string;
    content: string;
    metadata?: Record<string, unknown>;
    messageId?: string | null;
  }) {
    this.commitSdkMessageCalls.push(params);
    return {
      event_type: 'sdk_message',
      task_id: params.taskId,
      message_id: params.messageId ?? null,
      duplicate: false,
    };
  }

  async commitTaskStatusUpdate(params: {
    agentHost: string;
    taskId: string;
    status: string;
    summary?: string | null;
    statusEventId?: string | null;
  }) {
    this.commitTaskStatusCalls.push(params);
    return {
      event_type: 'task_status_update',
      task_id: params.taskId,
      status: String(params.status || '').toLowerCase(),
      duplicate: false,
    };
  }

  async commitAgentCommandAck(params: {
    agentHost: string;
    requestId: string;
    taskId?: string | null;
    accepted?: boolean;
    commandEventType?: string | null;
  }) {
    this.commitAgentCommandAckCalls.push(params);
    return {
      event_type: 'agent_command_ack',
      request_id: params.requestId,
      accepted: params.accepted !== false,
      duplicate: false,
    };
  }

  async commitTaskStopAck(params: {
    agentHost: string;
    taskId: string;
    requestId: string;
    accepted?: boolean;
  }) {
    this.commitTaskStopAckCalls.push(params);
    return {
      event_type: 'task_stop_ack',
      task_id: params.taskId,
      request_id: params.requestId,
      accepted: params.accepted !== false,
      duplicate: false,
    };
  }
}

class FakeWsClient {
  sent: Record<string, any>[] = [];
  handlers: Array<(payload: Record<string, any>) => Promise<void> | void> = [];
  connected = false;
  disconnected = false;
  connectCount = 0;
  disconnectCount = 0;

  registerHandler(handler: (payload: Record<string, any>) => Promise<void> | void): void {
    this.handlers.push(handler);
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.connectCount += 1;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.disconnectCount += 1;
  }

  async sendJson(payload: Record<string, any>): Promise<void> {
    this.sent.push(payload);
  }

  async emit(payload: Record<string, any>): Promise<void> {
    for (const handler of this.handlers) {
      await handler(payload);
    }
  }
}

describe('ConductorClient', () => {
  let backendApi: FakeBackendApi;
  let wsClient: FakeWsClient;
  let sessionStore: SessionDiskStore;
  let projectPath: string;
  let resolvedProjectPath: string;

  beforeEach(() => {
    backendApi = new FakeBackendApi();
    wsClient = new FakeWsClient();
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-client-project-'));
    resolvedProjectPath = fs.realpathSync(projectPath);
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-client-store-'));
    sessionStore = new SessionDiskStore(path.join(storeDir, 'session.yaml'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeClient() {
    return ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
    });
  }

  test('createTaskSession stores session and creates backend task', async () => {
    const client = await makeClient();
    const result = await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      backend_type: 'claude',
    });
    expect(result.task_id).toBeTruthy();
    expect(backendApi.createTaskCalls).toHaveLength(1);
    expect(backendApi.createTaskCalls[0].projectId).toBe('proj1');
    expect(backendApi.createTaskCalls[0].status).toBe('running');
    expect(backendApi.createTaskCalls[0].backendType).toBe('claude');
    expect(backendApi.createTaskCalls[0].sessionId).toBe(result.session_id);
    expect(backendApi.createTaskCalls[0].agentHost).toBe('conductor-fire-test-host-1');
    const record = sessionStore.findByPath(projectPath);
    expect(record?.projectId).toBe('proj1');
    expect(record?.taskIds.includes(result.task_id)).toBe(true);
    await client.close();
  });

  test('createTaskSession persists daemon name in task metadata without changing fire host', async () => {
    const client = await makeClient();
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      daemon_name: 'mac-studio',
    });

    expect(backendApi.createTaskCalls[0].agentHost).toBe('conductor-fire-test-host-1');
    expect(backendApi.createTaskCalls[0].metadata).toEqual({ daemonName: 'mac-studio' });
    await client.close();
  });

  test('bindTaskSession persists to backend API and local session store', async () => {
    const client = await makeClient();
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-bind-1',
    });

    const result = await client.bindTaskSession('task-bind-1', {
      backend_type: 'codex',
      session_id: 'session-bind-1',
      session_file_path: '/tmp/session-bind-1.jsonl',
    });

    expect(result.backend_type).toBe('codex');
    expect(result.session_id).toBe('session-bind-1');
    expect(result.session_file_path).toBe('/tmp/session-bind-1.jsonl');
    expect(backendApi.updateTaskCalls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-bind-1',
        backendType: 'codex',
        sessionId: 'session-bind-1',
        sessionFilePath: '/tmp/session-bind-1.jsonl',
      }),
    );
    const local = sessionStore.findByTaskId('task-bind-1');
    expect(local?.backendType).toBe('codex');
    expect(local?.sessionId).toBe('session-bind-1');
    expect(local?.sessionFilePath).toBe('/tmp/session-bind-1.jsonl');
    await client.close();
  });

  test('bindTaskSession forwards daemon name for manual fire task metadata repair', async () => {
    const client = await makeClient();
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-bind-daemon-1',
    });

    await client.bindTaskSession('task-bind-daemon-1', {
      backend_type: 'codex',
      daemon_name: 'mac-studio',
    });

    expect(backendApi.updateTaskCalls).toContainEqual(
      expect.objectContaining({
        taskId: 'task-bind-daemon-1',
        backendType: 'codex',
        metadata: { daemonName: 'mac-studio' },
      }),
    );
    await client.close();
  });

  test('getTask returns normalized task payload', async () => {
    const client = await makeClient();
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-get-1',
      backend_type: 'codex',
      session_id: 'session-get-1',
      session_file_path: '/tmp/session-get-1.jsonl',
    });

    const task = await client.getTask('task-get-1');

    expect(backendApi.getTaskCalls).toEqual(['task-get-1']);
    expect(task).toEqual({
      id: 'task-get-1',
      project_id: 'proj1',
      title: 'Hello',
      status: 'running',
      backend_type: 'codex',
      session_id: 'session-get-1',
      session_file_path: '/tmp/session-get-1.jsonl',
      created_at: null,
      updated_at: null,
    });
    await client.close();
  });

  test('createTaskSession surfaces free-plan limit message for manual fire tasks', async () => {
    const client = await makeClient();
    backendApi.createTask = (async () => {
      throw new BackendApiError('Backend responded with 403', 403, {
        error: 'Free plan task limit reached',
        message: 'Free plan allows only one active manual fire task',
        limit_type: 'manual_fire_active_task',
      });
    }) as any;

    await expect(
      client.createTaskSession({
        project_id: 'proj1',
        task_title: 'Blocked task',
      }),
    ).rejects.toThrow('Free plan limit reached: only 1 active fire task is allowed.');
    await client.close();
  });

  test('receiveMessages and ackMessages work with backend events', async () => {
    const client = await makeClient();
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task1',
    });

    await wsClient.emit({
      type: 'task_user_message',
      payload: {
        task_id: 'task1',
        project_id: 'proj1',
        message_id: 'msg1',
        role: 'user',
        content: 'hello',
        ack_token: 'ack1',
        metadata: { source: 'upload' },
        attachments: [
          {
            id: 'att-1',
            name: 'diagram.png',
            mimeType: 'image/png',
            downloadUrl: '/api/tasks/task1/attachments/att-1',
          },
        ],
      },
    });

    const batch = await client.receiveMessages('task1');
    expect(batch.messages).toHaveLength(1);
    expect(batch.messages[0].content).toBe('hello');
    expect(batch.messages[0].metadata).toEqual({ source: 'upload' });
    expect(batch.messages[0].attachments).toEqual([
      {
        id: 'att-1',
        name: 'diagram.png',
        mimeType: 'image/png',
        downloadUrl: '/api/tasks/task1/attachments/att-1',
      },
    ]);
    const ack = await client.ackMessages('task1', 'ack1');
    expect(ack).toEqual({ status: 'ok' });
    await client.close();
  });

  test('stop_task events invoke callback and send stop acknowledgements', async () => {
    const stopEvents: Array<{ taskId: string; requestId?: string; reason?: string }> = [];

    const client = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
      onStopTask: (event) => {
        stopEvents.push(event);
      },
    });
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-stop-1',
    });

    await wsClient.emit({
      type: 'stop_task',
      payload: {
        task_id: 'task-stop-1',
        request_id: 'req-stop-1',
        reason: 'deleted_by_user',
        delivery_cursor: {
          created_at: '2026-03-10T10:00:02.000Z',
          request_id: 'req-stop-1',
        },
      },
    });

    expect(stopEvents).toEqual([
      {
        taskId: 'task-stop-1',
        requestId: 'req-stop-1',
        reason: 'deleted_by_user',
      },
    ]);
    expect(backendApi.commitTaskStopAckCalls).toContainEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        taskId: 'task-stop-1',
        requestId: 'req-stop-1',
        accepted: true,
      }),
    );
    expect(backendApi.commitAgentCommandAckCalls).toHaveLength(0);
    await client.close();
  });

  test('interrupt_turn events invoke callback and send command acknowledgements', async () => {
    const interruptEvents: Array<{ taskId: string; requestId?: string; reason?: string; targetReplyTo: string }> = [];

    const client = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
      onInterruptTurn: (event) => {
        interruptEvents.push(event);
      },
    });
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-interrupt-1',
    });

    await wsClient.emit({
      type: 'interrupt_turn',
      payload: {
        task_id: 'task-interrupt-1',
        request_id: 'req-interrupt-1',
        reason: 'user_interrupt',
        target_reply_to: 'msg-user-1',
      },
    });

    expect(interruptEvents).toEqual([
      {
        taskId: 'task-interrupt-1',
        requestId: 'req-interrupt-1',
        reason: 'user_interrupt',
        targetReplyTo: 'msg-user-1',
      },
    ]);
    expect(backendApi.commitAgentCommandAckCalls).toContainEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        requestId: 'req-interrupt-1',
        taskId: 'task-interrupt-1',
        commandEventType: 'interrupt_turn',
        accepted: true,
      }),
    );
    expect(backendApi.commitTaskStopAckCalls).toHaveLength(0);
    await client.close();
  });

  test('interrupt_turn acknowledgements wait for an async callback result before committing', async () => {
    let resolveInterrupt: ((accepted: boolean) => void) | null = null;

    const client = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
      onInterruptTurn: () =>
        new Promise<boolean>((resolve) => {
          resolveInterrupt = resolve;
        }),
    });
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-interrupt-pending-1',
    });

    const emitPromise = wsClient.emit({
      type: 'interrupt_turn',
      payload: {
        task_id: 'task-interrupt-pending-1',
        request_id: 'req-interrupt-pending-1',
        reason: 'user_interrupt',
        target_reply_to: 'msg-user-pending-1',
      },
    });

    await Promise.resolve();
    expect(backendApi.commitAgentCommandAckCalls).toHaveLength(0);

    resolveInterrupt?.(true);
    await emitPromise;

    expect(backendApi.commitAgentCommandAckCalls).toContainEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        requestId: 'req-interrupt-pending-1',
        taskId: 'task-interrupt-pending-1',
        commandEventType: 'interrupt_turn',
        accepted: true,
      }),
    );
    await client.close();
  });

  test('interrupt_turn acknowledgements stay rejected when the callback returns false', async () => {
    const client = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
      onInterruptTurn: () => false,
    });
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-interrupt-2',
    });

    await wsClient.emit({
      type: 'interrupt_turn',
      payload: {
        task_id: 'task-interrupt-2',
        request_id: 'req-interrupt-2',
        reason: 'user_interrupt',
        target_reply_to: 'msg-user-2',
      },
    });

    expect(backendApi.commitAgentCommandAckCalls).toContainEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        requestId: 'req-interrupt-2',
        taskId: 'task-interrupt-2',
        commandEventType: 'interrupt_turn',
        accepted: false,
      }),
    );
    await client.close();
  });

  test('refresh_session events invoke callback and send command acknowledgements', async () => {
    const refreshEvents: Array<{
      taskId: string;
      requestId?: string;
      reason?: string;
      sessionId: string;
      sessionFilePath?: string;
    }> = [];

    const client = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
      onRefreshSession: (event) => {
        refreshEvents.push(event);
      },
    });
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-refresh-1',
    });

    await wsClient.emit({
      type: 'refresh_session',
      payload: {
        task_id: 'task-refresh-1',
        request_id: 'req-refresh-1',
        reason: 'refresh_session_inplace',
        session_id: 'sess-refresh-1',
        session_file_path: '/tmp/sess-refresh-1.jsonl',
      },
    });

    expect(refreshEvents).toEqual([
      {
        taskId: 'task-refresh-1',
        requestId: 'req-refresh-1',
        reason: 'refresh_session_inplace',
        sessionId: 'sess-refresh-1',
        sessionFilePath: '/tmp/sess-refresh-1.jsonl',
      },
    ]);
    expect(backendApi.commitAgentCommandAckCalls).toContainEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        requestId: 'req-refresh-1',
        taskId: 'task-refresh-1',
        commandEventType: 'refresh_session',
        accepted: true,
      }),
    );
    await client.close();
  });

  test('refresh_session dispatch stays non-blocking while the refresh callback is still pending', async () => {
    const refreshEvents: Array<{ taskId: string; sessionId: string }> = [];
    const interruptEvents: Array<{ taskId: string; requestId?: string; targetReplyTo: string }> = [];
    let resolveRefresh: ((accepted: boolean) => void) | null = null;
    let notifyRefreshStarted: (() => void) | null = null;
    const refreshStarted = new Promise<void>((resolve) => {
      notifyRefreshStarted = resolve;
    });

    const client = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-test-host-1',
      onRefreshSession: async (event) => {
        refreshEvents.push({
          taskId: event.taskId,
          sessionId: event.sessionId,
        });
        notifyRefreshStarted?.();
        return await new Promise<boolean>((resolve) => {
          resolveRefresh = resolve;
        });
      },
      onInterruptTurn: (event) => {
        interruptEvents.push({
          taskId: event.taskId,
          requestId: event.requestId,
          targetReplyTo: event.targetReplyTo,
        });
        return true;
      },
    });
    await client.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-refresh-2',
    });

    const refreshEmitPromise = wsClient.emit({
      type: 'refresh_session',
      payload: {
        task_id: 'task-refresh-2',
        request_id: 'req-refresh-2',
        session_id: 'sess-refresh-2',
      },
    });
    await refreshStarted;

    expect(
      await Promise.race([
        refreshEmitPromise.then(() => 'resolved'),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 25)),
      ]),
    ).toBe('resolved');
    expect(refreshEvents).toEqual([
      {
        taskId: 'task-refresh-2',
        sessionId: 'sess-refresh-2',
      },
    ]);
    expect(backendApi.commitAgentCommandAckCalls).not.toContainEqual(
      expect.objectContaining({
        requestId: 'req-refresh-2',
        commandEventType: 'refresh_session',
      }),
    );

    await wsClient.emit({
      type: 'interrupt_turn',
      payload: {
        task_id: 'task-refresh-2',
        request_id: 'req-interrupt-after-refresh',
        target_reply_to: 'reply-after-refresh',
      },
    });

    expect(interruptEvents).toEqual([
      {
        taskId: 'task-refresh-2',
        requestId: 'req-interrupt-after-refresh',
        targetReplyTo: 'reply-after-refresh',
      },
    ]);
    expect(backendApi.commitAgentCommandAckCalls).toContainEqual(
      expect.objectContaining({
        requestId: 'req-interrupt-after-refresh',
        taskId: 'task-refresh-2',
        commandEventType: 'interrupt_turn',
        accepted: true,
      }),
    );

    resolveRefresh?.(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(backendApi.commitAgentCommandAckCalls).toContainEqual(
      expect.objectContaining({
        requestId: 'req-refresh-2',
        taskId: 'task-refresh-2',
        commandEventType: 'refresh_session',
        accepted: true,
      }),
    );
    await client.close();
  });

  test('sendTaskStatus commits over HTTP and sendRuntimeStatus stays on websocket', async () => {
    const client = await makeClient();
    const statusResult = await client.sendTaskStatus('task1', { status: 'KILLED', summary: 'bye' });
    await client.sendRuntimeStatus('task1', {
      state: 'WAIT_STREAM_END',
      status_line: 'Working...',
      reply_in_progress: true,
    });
    expect(backendApi.commitTaskStatusCalls).toHaveLength(1);
    expect(backendApi.commitTaskStatusCalls[0]).toEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        taskId: 'task1',
        status: 'KILLED',
        summary: 'bye',
      }),
    );
    expect(statusResult).toEqual(
      expect.objectContaining({
        delivered: true,
        status_event_id: expect.any(String),
      }),
    );
    expect(wsClient.sent).toHaveLength(1);
    expect(wsClient.sent[0]).toEqual(
      expect.objectContaining({
        type: 'task_runtime_status',
        payload: expect.objectContaining({
          task_id: 'task1',
          state: 'WAIT_STREAM_END',
          status_line: 'Working...',
          reply_in_progress: true,
        }),
      }),
    );
    await client.close();
  });

  test('sendMessage commits over HTTP with stable message id', async () => {
    const client = await makeClient();
    await expect(client.sendMessage('task1', 'hello', { stream: true })).resolves.toEqual(
      expect.objectContaining({
        delivered: true,
        message_id: expect.any(String),
      }),
    );
    expect(backendApi.commitSdkMessageCalls).toHaveLength(1);
    expect(backendApi.commitSdkMessageCalls[0]).toEqual(
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        taskId: 'task1',
        content: 'hello',
        metadata: { stream: true },
        messageId: expect.any(String),
      }),
    );
    expect(wsClient.sent.filter((entry) => entry.type === 'sdk_message')).toHaveLength(0);
    await client.close();
  });

  test('sendAgentCommandAck commits over HTTP', async () => {
    const client = await makeClient();
    await expect(
      client.sendAgentCommandAck({
        request_id: 'req-ack-1',
        task_id: 'task1',
        event_type: 'stop_task',
        accepted: true,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        delivered: true,
        request_id: 'req-ack-1',
      }),
    );
    expect(backendApi.commitAgentCommandAckCalls).toEqual([
      expect.objectContaining({
        agentHost: 'conductor-fire-test-host-1',
        requestId: 'req-ack-1',
        taskId: 'task1',
        commandEventType: 'stop_task',
        accepted: true,
      }),
    ]);
    expect(wsClient.sent.filter((entry) => entry.type === 'agent_command_ack')).toHaveLength(0);
    await client.close();
  });

  test('retryable HTTP failures are persisted and flushed after restart', async () => {
    const outboxPath = DurableUpstreamOutboxStore.filePathForProjectPath(
      projectPath,
      'agent:conductor-fire-test-host-1',
    );
    let shouldFail = true;
    const originalCommitSdkMessage = backendApi.commitSdkMessage.bind(backendApi);
    backendApi.commitSdkMessage = vi.fn(async (params) => {
      if (shouldFail) {
        throw new BackendApiError('Backend responded with 503', 503, { retryable: true });
      }
      return originalCommitSdkMessage(params);
    });

    const client = await makeClient();
    const firstResult = await client.sendMessage('task1', 'hello');
    expect(firstResult).toEqual(
      expect.objectContaining({
        delivered: false,
        pending: true,
        message_id: expect.any(String),
      }),
    );
    expect(JSON.parse(fs.readFileSync(outboxPath, 'utf-8')).entries).toHaveLength(1);
    await client.close();

    shouldFail = false;
    const replayClient = await makeClient();
    await (replayClient as any).requestDurableOutboxFlush(true);

    expect(JSON.parse(fs.readFileSync(outboxPath, 'utf-8')).entries).toHaveLength(0);
    expect(vi.mocked(backendApi.commitSdkMessage).mock.calls.length).toBeGreaterThanOrEqual(2);
    await replayClient.close();
  });

  test('close flushes pending task status updates before disconnecting', async () => {
    let shouldFail = true;
    const originalCommitTaskStatusUpdate = backendApi.commitTaskStatusUpdate.bind(backendApi);
    backendApi.commitTaskStatusUpdate = vi.fn(async (params) => {
      if (shouldFail) {
        shouldFail = false;
        throw new BackendApiError('Backend responded with 503', 503, { retryable: true });
      }
      return originalCommitTaskStatusUpdate(params);
    });

    const client = await makeClient();
    const firstResult = await client.sendTaskStatus('task1', { status: 'KILLED', summary: 'bye' });

    expect(firstResult).toEqual(
      expect.objectContaining({
        delivered: false,
        pending: true,
        status_event_id: expect.any(String),
      }),
    );
    expect((client as any).upstreamOutbox.load()).toHaveLength(1);

    await client.close();

    expect((client as any).upstreamOutbox.load()).toHaveLength(0);
    expect(vi.mocked(backendApi.commitTaskStatusUpdate)).toHaveBeenCalledTimes(2);
    expect(wsClient.disconnectCount).toBe(1);
  });

  test('new agent host does not flush another scope outbox from the same project path', async () => {
    const oldScopePath = DurableUpstreamOutboxStore.filePathForProjectPath(
      projectPath,
      'agent:conductor-fire-old-host',
    );
    const oldScopeStore = DurableUpstreamOutboxStore.forProjectPath(projectPath, 'agent:conductor-fire-old-host');
    oldScopeStore.upsert({
      stableId: 'msg-old-1',
      eventType: 'sdk_message',
      payload: {
        taskId: 'task-old-1',
        content: 'stale',
        messageId: 'msg-old-1',
      },
    });

    const isolatedClient = await ConductorClient.connect({
      config: makeConfig(),
      env: {
        CONDUCTOR_TASK_CREATE_RETRIES: '0',
        HOSTNAME: 'test-host',
      },
      projectPath,
      backendApi: backendApi as any,
      wsClient: wsClient as any,
      sessionStore,
      agentHost: 'conductor-fire-new-host',
    });

    await (isolatedClient as any).requestDurableOutboxFlush(true);

    expect(backendApi.commitSdkMessageCalls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(oldScopePath, 'utf-8')).entries).toHaveLength(1);
    await isolatedClient.close();
  });

  test('connect does not auto-flush agent-scoped residual outbox before task scope is known', async () => {
    const agentScopePath = DurableUpstreamOutboxStore.filePathForProjectPath(
      projectPath,
      'agent:conductor-fire-test-host-1',
    );
    const agentScopeStore = DurableUpstreamOutboxStore.forProjectPath(projectPath, 'agent:conductor-fire-test-host-1');
    agentScopeStore.upsert({
      stableId: 'msg-agent-1',
      eventType: 'sdk_message',
      payload: {
        taskId: 'task-old-1',
        content: 'stale',
        messageId: 'msg-agent-1',
      },
    });

    const client = await makeClient();

    expect(backendApi.commitSdkMessageCalls).toEqual([]);
    expect(JSON.parse(fs.readFileSync(agentScopePath, 'utf-8')).entries).toHaveLength(1);
    await client.close();
  });

  test('later sdk_message does not overtake an earlier pending sdk_message', async () => {
    let shouldFailFirst = true;
    const originalCommitSdkMessage = backendApi.commitSdkMessage.bind(backendApi);
    backendApi.commitSdkMessage = vi.fn(async (params) => {
      if (params.messageId === 'msg-a' && shouldFailFirst) {
        throw new BackendApiError('Backend responded with 503', 503, { retryable: true });
      }
      return originalCommitSdkMessage(params);
    });

    const client = await makeClient();
    const resultA = await (client as any).persistAndCommitUpstreamEvent({
      stableId: 'msg-a',
      eventType: 'sdk_message',
      payload: {
        taskId: 'task1',
        content: 'A',
        messageId: 'msg-a',
      },
    });
    const resultB = await (client as any).persistAndCommitUpstreamEvent({
      stableId: 'msg-b',
      eventType: 'sdk_message',
      payload: {
        taskId: 'task1',
        content: 'B',
        messageId: 'msg-b',
      },
    });

    expect(resultA).toEqual({ delivered: false, pending: true });
    expect(resultB).toEqual({ delivered: false, pending: true });
    expect(vi.mocked(backendApi.commitSdkMessage).mock.calls.map((call) => call[0].messageId)).toEqual(['msg-a']);

    shouldFailFirst = false;
    await (client as any).requestDurableOutboxFlush(true);

    expect(vi.mocked(backendApi.commitSdkMessage).mock.calls.map((call) => call[0].messageId)).toEqual([
      'msg-a',
      'msg-a',
      'msg-b',
    ]);
    await client.close();
  });

  test('replayed downstream commands are deduplicated and resume reports persisted cursor', async () => {
    const firstClient = await makeClient();
    await firstClient.createTaskSession({
      project_id: 'proj1',
      task_title: 'Hello',
      task_id: 'task-replay-1',
    });

    const replayPayload = {
      type: 'task_user_message',
      payload: {
        task_id: 'task-replay-1',
        project_id: 'proj1',
        request_id: 'cmd-1',
        message_id: 'msg-1',
        role: 'user',
        content: 'hello',
        ack_token: 'ack-1',
        delivery_cursor: {
          created_at: '2026-03-10T10:00:00.000Z',
          request_id: 'cmd-1',
        },
      },
    };

    await wsClient.emit(replayPayload);
    const firstBatch = await firstClient.receiveMessages('task-replay-1');
    expect(firstBatch.messages).toHaveLength(1);
    expect(backendApi.commitAgentCommandAckCalls).toHaveLength(1);
    await firstClient.close();

    wsClient = new FakeWsClient();
    const replayClient = await makeClient();
    await replayClient.bindTaskSession('task-replay-1', {
      project_id: 'proj1',
      project_path: projectPath,
    });
    await replayClient.sendAgentResume({
      active_tasks: ['task-replay-1'],
      source: 'conductor-fire',
    });

    expect(wsClient.sent).toContainEqual(
      expect.objectContaining({
        type: 'agent_resume',
        payload: expect.objectContaining({
          last_applied_cursor: {
            created_at: '2026-03-10T10:00:00.000Z',
            request_id: 'cmd-1',
          },
        }),
      }),
    );

    await wsClient.emit(replayPayload);
    const replayBatch = await replayClient.receiveMessages('task-replay-1');
    expect(replayBatch.messages).toEqual([]);
    expect(backendApi.commitAgentCommandAckCalls).toHaveLength(2);
    await replayClient.close();
  });

  test('match/bind/getLocal project path methods mirror prior behavior', async () => {
    backendApi.projects.push({
      id: 'p1',
      name: 'Demo',
      metadata: {},
    });
    const client = await makeClient();
    await client.createTaskSession({
      project_id: 'p1',
      task_title: 'Hello',
      task_id: 'task1',
    });

    const matched = await client.matchProjectByPath();
    expect(matched.project_id).toBe('p1');
    expect(matched.matched_path).toBe(resolvedProjectPath);

    const bound = await client.bindProjectPath('p1');
    expect(bound.success).toBe(true);
    expect(bound.project_id).toBe('p1');
    expect(bound.path).toBe(resolvedProjectPath);
    const local = await client.getLocalProjectRecord();
    expect(local.project_id).toBe('p1');
    expect(Array.isArray(local.task_id)).toBe(true);
    await client.close();
  });
});

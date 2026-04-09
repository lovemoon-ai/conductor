import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWSMessage, resolveAppWebSocketUrl, useWebSocketStore } from './store';
import { useChatStore } from '@/features/chat';
import { useRuntimeStore } from './runtime-store';
import { useTasksStore } from '@/features/tasks';
import { clearAllTerminalOutputSnapshots, getTerminalOutputSnapshot, useTerminalStore } from '@/features/terminal';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  static reset() {
    MockWebSocket.instances = [];
  }

  url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  closeCalls = 0;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closeCalls += 1;
    this.readyState = 3;
  }

  triggerOpen() {
    this.readyState = 1;
    this.onopen?.();
  }

  triggerClose() {
    this.readyState = 3;
    this.onclose?.();
  }

  triggerMessage(data: unknown) {
    this.onmessage?.({
      data: JSON.stringify(data),
    });
  }
}

describe('websocket connection lifecycle', () => {
  const originalAppWsUrl = process.env.NEXT_PUBLIC_APP_WS_URL;

  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    useChatStore.setState({
      messagesByTask: {},
      historyStateByTask: {},
      hydratedTaskIds: new Set(),
      loadingTasks: new Set(),
      error: null,
    });
    useWebSocketStore.setState({
      status: 'disconnected',
      ws: null,
      reconnectAttempts: 0,
    });
    MockWebSocket.reset();
    delete process.env.NEXT_PUBLIC_APP_WS_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAppWsUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_WS_URL;
    } else {
      process.env.NEXT_PUBLIC_APP_WS_URL = originalAppWsUrl;
    }
  });

  it('ignores stale socket close events after a new socket becomes current', () => {
    const location = window.location as Location & { protocol: string; host: string };
    location.protocol = 'http:';
    location.host = 'localhost:6152';

    useWebSocketStore.getState().connect('token-a');
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.triggerOpen();

    useWebSocketStore.setState({
      status: 'disconnected',
      ws: null,
      reconnectAttempts: 0,
    });

    useWebSocketStore.getState().connect('token-a');
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.triggerOpen();

    firstSocket.triggerClose();

    expect(useWebSocketStore.getState()).toMatchObject({
      status: 'connected',
      ws: secondSocket,
      reconnectAttempts: 0,
    });
  });

  it('uses NEXT_PUBLIC_APP_WS_URL when configured', () => {
    process.env.NEXT_PUBLIC_APP_WS_URL = 'https://ws.conductor-ai.top';

    expect(
      resolveAppWebSocketUrl('token-1', {
        protocol: 'http:',
        host: 'localhost:6152',
      } as Pick<Location, 'protocol' | 'host'>),
    ).toBe('wss://ws.conductor-ai.top/ws/app?token=token-1');
  });

  it('invalidates hydrated chat caches when the websocket reconnects', () => {
    const location = window.location as Location & { protocol: string; host: string };
    location.protocol = 'http:';
    location.host = 'localhost:6152';
    useChatStore.setState({
      messagesByTask: {
        'task-1': [
          {
            id: 'msg-1',
            taskId: 'task-1',
            role: 'assistant',
            content: 'cached',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
      },
      historyStateByTask: {
        'task-1': {
          hasMoreBefore: false,
          oldestMessageId: 'msg-1',
        },
      },
      hydratedTaskIds: new Set(['task-1']),
      loadingTasks: new Set(),
      error: null,
    });

    useWebSocketStore.getState().connect('token-a');
    MockWebSocket.instances[0].triggerOpen();

    expect(useChatStore.getState().hydratedTaskIds.size).toBe(0);
    expect(useChatStore.getState().messagesByTask['task-1']).toHaveLength(1);
  });
});

describe('websocket runtime status handling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    useRuntimeStore.getState().clearAll();
    useChatStore.setState({
      messagesByTask: {},
      historyStateByTask: {},
      hydratedTaskIds: new Set(),
      loadingTasks: new Set(),
      error: null,
    });
    useTasksStore.setState({
      tasks: [],
      isLoading: false,
      error: null,
      currentProjectFilter: null,
      unreadTaskIds: new Set(),
    });
    clearAllTerminalOutputSnapshots();
    useTerminalStore.setState({
      byTask: {},
    });
    useWebSocketStore.setState({
      status: 'disconnected',
      ws: null,
      reconnectAttempts: 0,
    });
  });

  it('stores runtime status from task_runtime_status events', () => {
    handleWSMessage({
      type: 'task_runtime_status',
      payload: {
        task_id: 'task-1',
        state: 'WAIT_STREAM_END',
        status_line: 'Working...',
        reply_in_progress: true,
        daemon: 'daemon-a',
        pid: 12345,
        session_id: 'session-1',
        token_usage_percent: 26,
        context_usage_percent: 5,
      },
    });

    const runtime = useRuntimeStore.getState().byTask['task-1'];
    expect(runtime).toBeDefined();
    expect(runtime.state).toBe('WAIT_STREAM_END');
    expect(runtime.statusLine).toBe('Working...');
    expect(runtime.replyInProgress).toBe(true);
    expect(runtime.daemon).toBe('daemon-a');
    expect(runtime.pid).toBe(12345);
    expect(runtime.sessionId).toBe('session-1');
    expect(runtime.tokenUsagePercent).toBe(26);
    expect(runtime.contextUsagePercent).toBe(5);
  });

  it('keeps runtime status when assistant message arrives', () => {
    useRuntimeStore.getState().setStatus({
      taskId: 'task-2',
      state: 'WAIT_STREAM_END',
      statusLine: 'Still running',
    });

    handleWSMessage({
      type: 'task_sdk_message',
      payload: {
        id: 'msg-1',
        task_id: 'task-2',
        role: 'sdk',
        content: 'Done',
      },
    });

    expect(useRuntimeStore.getState().byTask['task-2']).toMatchObject({
      taskId: 'task-2',
      state: 'WAIT_STREAM_END',
      statusLine: 'Still running',
    });
    const messages = useChatStore.getState().messagesByTask['task-2'] ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Done');
  });

  it('fetches task detail when a task status arrives before the task exists in the store', () => {
    const fetchTaskSpy = vi.spyOn(useTasksStore.getState(), 'fetchTask').mockResolvedValue(null);

    handleWSMessage({
      type: 'task_status_update',
      payload: {
        task_id: 'task-init-1',
        status: 'running',
      },
    });

    expect(fetchTaskSpy).toHaveBeenCalledWith('task-init-1');
  });

  it('moves tasks with new assistant messages to the top and refreshes their preview', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Older task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'task-2',
          title: 'New message task',
          taskType: 'ai_task',
          status: 'running',
          lastAssistantMessage: 'Old reply',
          createdAt: '2024-01-01T00:01:00.000Z',
          updatedAt: '2024-01-01T00:01:00.000Z',
        },
      ],
      unreadTaskIds: new Set(),
    });

    handleWSMessage({
      type: 'task_sdk_message',
      payload: {
        id: 'msg-3',
        task_id: 'task-2',
        role: 'sdk',
        content: 'Fresh reply',
        created_at: '2024-01-01T00:05:00.000Z',
      },
    });

    expect(useTasksStore.getState().tasks.map((task) => task.id)).toEqual(['task-2', 'task-1']);
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-2',
      lastAssistantMessage: 'Fresh reply',
      updatedAt: '2024-01-01T00:05:00.000Z',
    });
    expect(useTasksStore.getState().unreadTaskIds.has('task-2')).toBe(true);
    expect(useChatStore.getState().messagesByTask['task-2']).toMatchObject([
      expect.objectContaining({
        id: 'msg-3',
        content: 'Fresh reply',
      }),
    ]);
  });

  it('moves tasks with new user messages to the top and refreshes their preview', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-1',
          title: 'Older task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
        },
        {
          id: 'task-2',
          title: 'New user message task',
          taskType: 'ai_task',
          status: 'running',
          lastUserMessage: 'Old prompt',
          lastAssistantMessage: 'Stable reply',
          createdAt: '2024-01-01T00:01:00.000Z',
          updatedAt: '2024-01-01T00:01:00.000Z',
        },
      ],
      unreadTaskIds: new Set(),
    });

    handleWSMessage({
      type: 'task_user_message',
      payload: {
        id: 'msg-4',
        task_id: 'task-2',
        role: 'user',
        content: 'Fresh prompt',
        created_at: '2024-01-01T00:06:00.000Z',
      },
    });

    expect(useTasksStore.getState().tasks.map((task) => task.id)).toEqual(['task-2', 'task-1']);
    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-2',
      lastUserMessage: 'Fresh prompt',
      lastAssistantMessage: 'Stable reply',
      updatedAt: '2024-01-01T00:06:00.000Z',
    });
    expect(useTasksStore.getState().unreadTaskIds.size).toBe(0);
    expect(useChatStore.getState().messagesByTask['task-2']).toMatchObject([
      expect.objectContaining({
        id: 'msg-4',
        role: 'user',
        content: 'Fresh prompt',
      }),
    ]);
  });

  it('stores PTY transport session events', () => {
    handleWSMessage({
      type: 'pty_transport_session',
      payload: {
        task_id: 'task-pty-transport',
        session_id: 'transport-1',
        transport_policy: 'direct_preferred',
        writer_connection_id: 'conn-1',
        direct_candidate: true,
      },
    });

    expect(useTerminalStore.getState().byTask['task-pty-transport']).toMatchObject({
      transportState: 'relay',
      transportSession: {
        sessionId: 'transport-1',
        transportPolicy: 'direct_preferred',
        writerConnectionId: 'conn-1',
        directCandidate: true,
      },
    });
  });

  it('updates PTY transport state from status events', () => {
    handleWSMessage({
      type: 'pty_transport_session',
      payload: {
        task_id: 'task-pty-transport-status',
        session_id: 'transport-2',
        transport_policy: 'direct_preferred',
        direct_candidate: true,
      },
    });

    handleWSMessage({
      type: 'pty_transport_status',
      payload: {
        task_id: 'task-pty-transport-status',
        session_id: 'transport-2',
        transport_state: 'fallback_relay',
        reason: 'direct_transport_not_supported',
      },
    });

    expect(useTerminalStore.getState().byTask['task-pty-transport-status']).toMatchObject({
      transportState: 'fallback_relay',
      transportSession: {
        sessionId: 'transport-2',
        transportPolicy: 'direct_preferred',
      },
    });
  });

  it('ignores relayed terminal_output for the current direct writer to avoid duplicate render', () => {
    useTerminalStore.setState({
      byTask: {
        'task-pty-direct': {
          taskId: 'task-pty-direct',
          connectionState: 'open',
          isAttached: true,
          hasWriteAccess: true,
          viewerCount: 1,
          preferredMode: 'write',
          transportState: 'direct',
          transportSession: {
            sessionId: 'transport-direct-1',
            transportState: 'direct',
            transportPolicy: 'direct_preferred',
            issuedAt: null,
            expiresAt: null,
            writerConnectionId: 'conn-1',
            ticket: null,
            directCandidate: true,
          },
          banner: null,
        },
      },
    });

    handleWSMessage({
      type: 'terminal_output',
      payload: {
        task_id: 'task-pty-direct',
        seq: 1,
        data: 'relay chunk',
      },
    });

    expect(useTerminalStore.getState().byTask['task-pty-direct']).toMatchObject({
      transportState: 'direct',
    });
    expect(getTerminalOutputSnapshot('task-pty-direct')).toMatchObject({
      lastSeq: 0,
      chunks: [],
    });
    expect(useTerminalStore.getState().byTask['task-pty-direct'].lastLatencySample ?? null).toBeNull();
  });

  it('does not emit per-message debug logs for sdk and terminal output events', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    handleWSMessage({
      type: 'task_sdk_message',
      payload: {
        id: 'msg-2',
        task_id: 'task-3',
        role: 'sdk',
        content: 'Done',
      },
    });
    handleWSMessage({
      type: 'terminal_output',
      payload: {
        task_id: 'task-pty-debug',
        seq: 1,
        data: 'chunk',
      },
    });

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('stores terminal lifecycle and output events', () => {
    handleWSMessage({
      type: 'terminal_opened',
      payload: {
        task_id: 'task-pty-1',
        pty_session_id: 'pty-1',
        cwd: '/tmp/worktree',
        shell: '/bin/zsh',
        cols: 120,
        rows: 40,
      },
    });
    handleWSMessage({
      type: 'terminal_output',
      payload: {
        task_id: 'task-pty-1',
        seq: 1,
        data: 'hello from terminal',
        latency_sample: {
          client_input_seq: 7,
          client_sent_at: '2026-03-17T01:00:00.000Z',
          server_received_at: '2026-03-17T01:00:00.010Z',
          daemon_received_at: '2026-03-17T01:00:00.020Z',
          first_output_at: '2026-03-17T01:00:00.050Z',
          daemon_input_to_first_output_ms: 30,
        },
      },
    });
    handleWSMessage({
      type: 'terminal_exit',
      payload: {
        task_id: 'task-pty-1',
        seq: 1,
        exit_code: 0,
      },
    });

    const terminal = useTerminalStore.getState().byTask['task-pty-1'];
    const snapshot = getTerminalOutputSnapshot('task-pty-1');
    expect(terminal).toBeDefined();
    expect(terminal.connectionState).toBe('exited');
    expect(terminal.ptySessionId).toBe('pty-1');
    expect(terminal.cwd).toBe('/tmp/worktree');
    expect(terminal.shell).toBe('/bin/zsh');
    expect(snapshot.lastSeq).toBe(1);
    expect(snapshot.chunks).toEqual(['hello from terminal']);
    expect(terminal.exitCode).toBe(0);
    expect(terminal.lastLatencySample).toMatchObject({
      clientInputSeq: 7,
      daemonInputToFirstOutputMs: 30,
      clientSentAt: '2026-03-17T01:00:00.000Z',
      serverReceivedAt: '2026-03-17T01:00:00.010Z',
    });
  });

  it('applies terminal_snapshot and flushes queued output for fresh attaches', () => {
    useTerminalStore.getState().beginFreshResumeAttach('task-pty-snapshot');

    handleWSMessage({
      type: 'terminal_output',
      payload: {
        task_id: 'task-pty-snapshot',
        seq: 4,
        data: 'live tail',
      },
    });

    expect(getTerminalOutputSnapshot('task-pty-snapshot')).toMatchObject({
      lastSeq: 0,
      chunks: [],
    });

    handleWSMessage({
      type: 'terminal_snapshot',
      payload: {
        task_id: 'task-pty-snapshot',
        last_seq: 3,
        data: 'history',
        truncated: false,
      },
    });

    expect(getTerminalOutputSnapshot('task-pty-snapshot')).toMatchObject({
      lastSeq: 4,
      chunks: ['history', 'live tail'],
    });
  });

  it('removes deleted tasks and clears related stores', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-delete-1',
          title: 'Delete Me',
          taskType: 'pty_task',
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
      error: null,
      currentProjectFilter: null,
      unreadTaskIds: new Set(['task-delete-1']),
    });
    useChatStore.setState({
      messagesByTask: {
        'task-delete-1': [
          {
            id: 'msg-delete-1',
            taskId: 'task-delete-1',
            role: 'sdk',
            content: 'hello',
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        ],
      },
      historyStateByTask: {
        'task-delete-1': {
          hasMoreBefore: false,
          oldestMessageId: 'msg-delete-1',
        },
      },
      hydratedTaskIds: new Set(['task-delete-1']),
      loadingTasks: new Set(),
      error: null,
    });
    useRuntimeStore.getState().setStatus({
      taskId: 'task-delete-1',
      state: 'RUNNING',
    });
    useTerminalStore.getState().markOpened({
      task_id: 'task-delete-1',
      pty_session_id: 'pty-delete-1',
    });

    handleWSMessage({
      type: 'task_deleted',
      payload: {
        task_id: 'task-delete-1',
      },
    });

    expect(useTasksStore.getState().tasks).toEqual([]);
    expect(useTasksStore.getState().unreadTaskIds.size).toBe(0);
    expect(useChatStore.getState().messagesByTask['task-delete-1']).toBeUndefined();
    expect(useRuntimeStore.getState().byTask['task-delete-1']).toBeUndefined();
    expect(useTerminalStore.getState().byTask['task-delete-1']).toBeUndefined();
  });

  it('updates terminal writer access from realtime events', () => {
    handleWSMessage({
      type: 'terminal_opened',
      payload: {
        task_id: 'task-pty-4',
        pty_session_id: 'pty-4',
      },
    });

    handleWSMessage({
      type: 'terminal_access_updated',
      payload: {
        task_id: 'task-pty-4',
        write_access: true,
        writer_active: true,
        viewer_count: 3,
      },
    });

    expect(useTerminalStore.getState().byTask['task-pty-4']).toMatchObject({
      hasWriteAccess: true,
      viewerCount: 3,
      banner: {
        tone: 'success',
        message: 'Write access granted.',
      },
    });
  });

  it('downgrades terminal sessions when killed status arrives without terminal_exit', () => {
    handleWSMessage({
      type: 'terminal_opened',
      payload: {
        task_id: 'task-pty-5',
        pty_session_id: 'pty-5',
      },
    });
    handleWSMessage({
      type: 'terminal_access_updated',
      payload: {
        task_id: 'task-pty-5',
        write_access: true,
        writer_active: true,
        viewer_count: 1,
      },
    });

    useTasksStore.setState({
      tasks: [
        {
          id: 'task-pty-5',
          title: 'Killed PTY',
          taskType: 'pty_task',
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    handleWSMessage({
      type: 'task_status_update',
      payload: {
        task_id: 'task-pty-5',
        status: 'killed',
      },
    });

    expect(useTerminalStore.getState().byTask['task-pty-5']).toMatchObject({
      connectionState: 'exited',
      isAttached: false,
      hasWriteAccess: false,
      banner: {
        tone: 'warning',
        message: 'Task was killed. Terminal session is no longer active.',
      },
    });
  });

  it('keeps completed task_status_update events as completed in the task list', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-ai-1',
          title: 'Stopped By App',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
    });

    handleWSMessage({
      type: 'task_status_update',
      payload: {
        task_id: 'task-ai-1',
        status: 'completed',
      },
    });

    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-ai-1',
      status: 'completed',
    });
  });
});

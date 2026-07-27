import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleWSMessage, resolveAppWebSocketUrl, useWebSocketStore } from './store';
import { useChatStore } from '@/features/chat';
import { useProjectsStore } from '@/features/projects/store';
import { useRuntimeStore } from './runtime-store';
import { useTasksStore } from '@/features/tasks';
import { clearAllTerminalOutputSnapshots, getTerminalOutputSnapshot, useTerminalStore } from '@/features/terminal';
import { useUserPreferencesStore } from '@/features/user-preferences/store';
import { useCatchphrasesStore } from '@/features/catchphrases/store';
import { useDailyReportsStore } from '@/features/daily-reports/store';
import { useTaskCardGroupsSyncStore } from '@/features/tasks/task-card-groups-sync-store';

const dailyReportActions = {
  hydrateSetting: useDailyReportsStore.getState().hydrateSetting,
  updateSetting: useDailyReportsStore.getState().updateSetting,
  fetchReport: useDailyReportsStore.getState().fetchReport,
  generateReport: useDailyReportsStore.getState().generateReport,
  fetchHistory: useDailyReportsStore.getState().fetchHistory,
  applySettingUpdate: useDailyReportsStore.getState().applySettingUpdate,
  handleReportReady: useDailyReportsStore.getState().handleReportReady,
  clearError: useDailyReportsStore.getState().clearError,
};

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
    vi.spyOn(useTasksStore.getState(), 'fetchTask').mockResolvedValue(null);
    clearAllTerminalOutputSnapshots();
    useTerminalStore.setState({
      byTask: {},
    });
    useWebSocketStore.setState({
      status: 'disconnected',
      ws: null,
      reconnectAttempts: 0,
    });
    useUserPreferencesStore.setState({
      taskListRunningOnly: false,
      taskListPreferencesHydrated: false,
      taskListPreferencesLoading: false,
      taskListPreferencesError: null,
    });
    useTaskCardGroupsSyncStore.getState().reset();
    useDailyReportsStore.setState({
      setting: null,
      currentReport: null,
      history: [],
      isLoadingSetting: false,
      isLoadingReport: false,
      isSavingSetting: false,
      isGenerating: false,
      error: null,
      ...dailyReportActions,
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

  it('applies task list preferences from user_preference_update events', () => {
    handleWSMessage({
      type: 'user_preference_update',
      payload: {
        scope: 'task_list',
        preferences: {
          tasks_running_only: true,
        },
      },
    });

    expect(useUserPreferencesStore.getState().taskListRunningOnly).toBe(true);
    expect(useUserPreferencesStore.getState().taskListPreferencesHydrated).toBe(true);
  });

  it('applies task card groups pushed from another device', () => {
    handleWSMessage({
      type: 'task_card_groups_update',
      payload: {
        user_id: 'user-1',
        snapshot: {
          version: 1,
          revision: 7,
          scopes: {
            'projects:p1': [{ id: 'g1', taskIds: ['a', 'b'], labels: {} }],
          },
        },
      },
    });

    expect(useTaskCardGroupsSyncStore.getState()).toMatchObject({
      hydrated: true,
      snapshot: {
        revision: 7,
        scopes: {
          'projects:p1': [{ id: 'g1', taskIds: ['a', 'b'], labels: {} }],
        },
      },
    });
  });

  it('applies the full catchphrase snapshot from user_catchphrase_update events (RFC 0032)', () => {
    // Seed pre-existing local state — the realtime push must overwrite, not merge.
    useCatchphrasesStore.setState({
      catchphrases: [
        {
          id: 'stale-1',
          text: 'stale',
          sortOrder: 0,
          lastUsedAt: null,
          createdAt: '2026-06-06T00:00:00Z',
          updatedAt: '2026-06-06T00:00:00Z',
        },
      ],
      hydrated: true,
      loading: false,
      error: null,
    });

    handleWSMessage({
      type: 'user_catchphrase_update',
      payload: {
        catchphrases: [
          {
            id: 'fresh-1',
            text: 'fresh A',
            sortOrder: 0,
            lastUsedAt: null,
            createdAt: '2026-06-07T00:00:00Z',
            updatedAt: '2026-06-07T00:00:00Z',
          },
          {
            id: 'fresh-2',
            text: 'fresh B',
            sortOrder: 1,
            lastUsedAt: null,
            createdAt: '2026-06-07T00:00:00Z',
            updatedAt: '2026-06-07T00:00:00Z',
          },
        ],
        updated_at: '2026-06-07T00:00:00Z',
      },
    });

    const state = useCatchphrasesStore.getState();
    expect(state.catchphrases.map((row) => row.id)).toEqual(['fresh-1', 'fresh-2']);
    expect(state.hydrated).toBe(true);
  });

  it('applies daily report setting updates from realtime events', () => {
    handleWSMessage({
      type: 'daily_report_setting_update',
      payload: {
        setting: {
          enabled: false,
          timezone: 'Europe/London',
          sendTimeLocal: '20:00',
          deliveryChannels: ['in_app'],
          nextRunAt: null,
          lastSentForDate: '2026-07-01',
          lastRunAt: null,
          lastError: null,
        },
      },
    });

    expect(useDailyReportsStore.getState().setting).toMatchObject({
      enabled: false,
      timezone: 'Europe/London',
      sendTimeLocal: '20:00',
      lastSentForDate: '2026-07-01',
    });
  });

  it('refreshes daily report history and the open report from ready events', async () => {
    const fetchHistory = vi.fn().mockResolvedValue(undefined);
    const fetchReport = vi.fn().mockResolvedValue(null);
    useDailyReportsStore.setState({
      currentReport: {
        id: 'report-preview',
        reportDate: '2026-07-01',
        timezone: 'Asia/Shanghai',
        status: 'preview',
        summaryMarkdown: '# old',
        payload: {
          totals: { projects: 0, tasks: 0, messages: 0, completed: 0, running: 0, killed: 0 },
          projects: [],
          summarizer: null,
        },
        deliveryChannels: ['in_app'],
        sentAt: null,
        lastError: null,
        persisted: false,
        createdAt: null,
        updatedAt: null,
      },
      fetchHistory,
      fetchReport,
    });

    handleWSMessage({
      type: 'daily_report_ready',
      payload: {
        reportDate: '2026-07-01',
        timezone: 'Asia/Shanghai',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(fetchReport).toHaveBeenCalledWith('2026-07-01', 'Asia/Shanghai');
  });

  it('preserves stable runtime details across partial task_runtime_status updates', () => {
    handleWSMessage({
      type: 'task_runtime_status',
      payload: {
        task_id: 'task-runtime-merge-1',
        state: 'WAIT_STREAM_END',
        status_line: 'Working...',
        daemon: 'daemon-a',
        pid: 12345,
        backend: 'codex',
        session_id: 'session-1',
        token_usage_percent: 26,
        context_usage_percent: 5,
      },
    });

    handleWSMessage({
      type: 'task_runtime_status',
      payload: {
        task_id: 'task-runtime-merge-1',
        state: 'WAIT_INPUT',
        phase: 'message_aggregation',
        status_done_line: 'Reply complete',
      },
    });

    expect(useRuntimeStore.getState().byTask['task-runtime-merge-1']).toMatchObject({
      taskId: 'task-runtime-merge-1',
      state: 'WAIT_INPUT',
      phase: 'message_aggregation',
      statusLine: undefined,
      statusDoneLine: 'Reply complete',
      daemon: 'daemon-a',
      pid: 12345,
      backend: 'codex',
      sessionId: 'session-1',
      tokenUsagePercent: 26,
      contextUsagePercent: 5,
    });
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
    const fetchTaskSpy = vi.mocked(useTasksStore.getState().fetchTask);

    handleWSMessage({
      type: 'task_status_update',
      payload: {
        task_id: 'task-init-1',
        status: 'running',
      },
    });

    expect(fetchTaskSpy).toHaveBeenCalledWith('task-init-1');
  });

  it('merges killing metadata and updatedAt from task_status_update events', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-killing-1',
          title: 'Stopping task',
          taskType: 'ai_task',
          status: 'running',
          metadata: null,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:05.000Z',
        },
      ],
    });

    handleWSMessage({
      type: 'task_status_update',
      payload: {
        task_id: 'task-killing-1',
        status: 'killing',
        updated_at: '2024-01-01T00:00:10.000Z',
        metadata: {
          killingStartedAt: '2024-01-01T00:00:10.000Z',
          killingTimeoutMs: 60_000,
        },
      },
    });

    expect(useTasksStore.getState().tasks[0]).toMatchObject({
      id: 'task-killing-1',
      status: 'killing',
      updatedAt: '2024-01-01T00:00:10.000Z',
      metadata: {
        killingStartedAt: '2024-01-01T00:00:10.000Z',
        killingTimeoutMs: 60_000,
      },
    });
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

  it('removes a task from the active list on task_achieved (like delete, keeps server transcript)', () => {
    useTasksStore.setState({
      tasks: [
        {
          id: 'task-pack-1',
          title: 'Pack Me',
          taskType: 'ai_task',
          status: 'killed',
          createdAt: '2024-01-01T00:00:00.000Z',
        },
      ],
      isLoading: false,
      error: null,
      currentProjectFilter: null,
      unreadTaskIds: new Set(['task-pack-1']),
    });

    handleWSMessage({
      type: 'task_achieved',
      payload: { task_id: 'task-pack-1', project_id: 'proj-1' },
    });

    expect(useTasksStore.getState().tasks).toEqual([]);
    expect(useTasksStore.getState().unreadTaskIds.size).toBe(0);
  });

  it('refetches within the current project scope on task_restored', () => {
    const fetchTasksSpy = vi
      .spyOn(useTasksStore.getState(), 'fetchTasks')
      .mockResolvedValue(undefined);
    const fetchGroupSpy = vi
      .spyOn(useTasksStore.getState(), 'fetchTasksForProjects')
      .mockResolvedValue(undefined);

    // Single-project scope.
    useTasksStore.setState({ currentProjectFilter: 'proj-9', currentProjectIds: [] });
    handleWSMessage({ type: 'task_restored', payload: { task_id: 't', project_id: 'proj-9' } });
    expect(fetchTasksSpy).toHaveBeenCalledWith('proj-9');
    expect(fetchGroupSpy).not.toHaveBeenCalled();

    // Merged-group scope.
    fetchTasksSpy.mockClear();
    useTasksStore.setState({ currentProjectFilter: null, currentProjectIds: ['a', 'b'] });
    handleWSMessage({ type: 'task_restored', payload: { task_id: 't', project_id: 'a' } });
    expect(fetchGroupSpy).toHaveBeenCalledWith(['a', 'b']);
    expect(fetchTasksSpy).not.toHaveBeenCalled();
  });

  it('refreshes projects when a projects_reordered event arrives', () => {
    const fetchProjectsSpy = vi.spyOn(useProjectsStore.getState(), 'fetchProjects').mockResolvedValue(undefined);

    handleWSMessage({
      type: 'projects_reordered',
      payload: {
        project_ids: ['project-b', 'project-a'],
      },
    });

    expect(fetchProjectsSpy).toHaveBeenCalledTimes(1);
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

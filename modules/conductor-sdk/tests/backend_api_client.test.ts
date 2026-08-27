import { afterEach, describe, expect, test } from 'vitest';

import { BackendApiClient, BackendApiError, ProjectSummary } from '../src/backend/index.js';
import { ConductorConfig } from '../src/config/index.js';

type FetchFn = Parameters<ConstructorParameters<typeof BackendApiClient>[1]>[0]['fetchImpl'];

function makeConfig(): ConductorConfig {
  return new ConductorConfig({
    agentToken: 'token',
    backendUrl: 'https://backend.local',
  });
}

describe('BackendApiClient', () => {
  test('listProjects returns summaries', async () => {
    const fetchImpl: FetchFn = async (url, init) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer token' });
      return new Response(
        JSON.stringify([
          { id: 'p1', name: 'Demo' },
          { id: 'p2', name: null },
          { name: 'missing-id' },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const projects = await client.listProjects();
    expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(projects[0].name).toBe('Demo');
  });

  test('listProjects handles HTTP errors', async () => {
    const fetchImpl: FetchFn = async () => new Response('boom', { status: 500 });
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    await expect(client.listProjects()).rejects.toBeInstanceOf(BackendApiError);
  });

  test('listProjects validates response shape', async () => {
    const fetchImpl: FetchFn = async () =>
      new Response(JSON.stringify({ unexpected: true }), { status: 200 });
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    await expect(client.listProjects()).rejects.toBeInstanceOf(BackendApiError);
  });

  test('retries with /api prefix after 404 for Next.js-style backend root URL', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchFn = async (url) => {
      urls.push(String(url));
      if (String(url) === 'https://backend.local/projects') {
        return new Response('not found', { status: 404 });
      }
      if (String(url) === 'https://backend.local/api/projects') {
        return new Response(JSON.stringify([{ id: 'p1', name: 'Demo' }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('unexpected', { status: 500 });
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const projects = await client.listProjects();
    expect(projects).toHaveLength(1);
    expect(urls).toEqual([
      'https://backend.local/projects',
      'https://backend.local/api/projects',
    ]);
  });

  test('createAppTask posts directly to the frontend task pipeline', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchFn = async (url, init) => {
      urls.push(String(url));
      expect(init?.method).toBe('POST');
      expect(init?.body ? JSON.parse(String(init.body)) : {}).toMatchObject({
        projectId: 'proj-1',
        title: 'Task 1',
        taskType: 'ai_task',
        initialContent: 'Start now',
        backendType: 'codex',
      });
      return new Response(
        JSON.stringify({
          id: 'task-1',
          project_id: 'proj-1',
          title: 'Task 1',
          task_type: 'ai_task',
          status: 'init',
          backend_type: 'codex',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const task = await client.createAppTask({
      projectId: 'proj-1',
      title: 'Task 1',
      taskType: 'ai_task',
      initialContent: 'Start now',
      backendType: 'codex',
    });

    expect(task.id).toBe('task-1');
    expect(urls).toEqual(['https://backend.local/api/tasks']);
  });

  test('updateTask sends PATCH payload and parses task summary', async () => {
    const fetchImpl: FetchFn = async (url, init) => {
      expect(String(url)).toBe('https://backend.local/tasks/task-1');
      expect(init?.method).toBe('PATCH');
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toMatchObject({
        backendType: 'codex',
        sessionId: 'session-1',
        sessionFilePath: '/tmp/session-1.jsonl',
      });
      return new Response(
        JSON.stringify({
          id: 'task-1',
          project_id: 'proj-1',
          title: 'Task 1',
          status: 'running',
          backend_type: 'codex',
          session_id: 'session-1',
          session_file_path: '/tmp/session-1.jsonl',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const task = await client.updateTask('task-1', {
      backendType: 'codex',
      sessionId: 'session-1',
      sessionFilePath: '/tmp/session-1.jsonl',
    });
    expect(task.id).toBe('task-1');
    expect(task.backendType).toBe('codex');
    expect(task.sessionId).toBe('session-1');
    expect(task.sessionFilePath).toBe('/tmp/session-1.jsonl');
  });

  test('getTask sends GET request and parses task summary', async () => {
    const fetchImpl: FetchFn = async (url, init) => {
      expect(String(url)).toBe('https://backend.local/tasks/task-1');
      expect(init?.method).toBe('GET');
      return new Response(
        JSON.stringify({
          id: 'task-1',
          project_id: 'proj-1',
          title: 'Task 1',
          status: 'running',
          backend_type: 'codex',
          session_id: 'session-1',
          session_file_path: '/tmp/session-1.jsonl',
          created_at: '2026-04-23T09:00:00.000Z',
          updated_at: '2026-04-23T09:01:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const task = await client.getTask('task-1');
    expect(task.id).toBe('task-1');
    expect(task.projectId).toBe('proj-1');
    expect(task.backendType).toBe('codex');
    expect(task.sessionId).toBe('session-1');
    expect(task.createdAt).toBe('2026-04-23T09:00:00.000Z');
    expect(task.updatedAt).toBe('2026-04-23T09:01:00.000Z');
  });

  test('commitAgentEvents posts agent upstream payload', async () => {
    const fetchImpl: FetchFn = async (url, init) => {
      expect(String(url)).toBe('https://backend.local/agent/events');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      });
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toEqual({
        agent_host: 'conductor-fire-test',
        events: [
          {
            event_type: 'sdk_message',
            task_id: 'task-1',
            content: 'hello',
            metadata: { stream: true },
            message_id: 'msg-1',
          },
        ],
      });
      return new Response(
        JSON.stringify({
          results: [{ event_type: 'sdk_message', task_id: 'task-1', message_id: 'msg-1', duplicate: false }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const result = await client.commitAgentEvents({
      agentHost: 'conductor-fire-test',
      events: [
        {
          eventType: 'sdk_message',
          taskId: 'task-1',
          content: 'hello',
          metadata: { stream: true },
          messageId: 'msg-1',
        },
      ],
    });
    expect(result.results).toEqual([
      expect.objectContaining({ event_type: 'sdk_message', task_id: 'task-1', message_id: 'msg-1' }),
    ]);
  });

  test('commitTaskStatusUpdate retries with /api prefix after 404', async () => {
    const urls: string[] = [];
    const fetchImpl: FetchFn = async (url) => {
      urls.push(String(url));
      if (String(url) === 'https://backend.local/agent/events') {
        return new Response('not found', { status: 404 });
      }
      return new Response(
        JSON.stringify({
          results: [{ event_type: 'task_status_update', task_id: 'task-1', status: 'running', duplicate: false }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const result = await client.commitTaskStatusUpdate({
      agentHost: 'conductor-fire-test',
      taskId: 'task-1',
      status: 'RUNNING',
      summary: 'reconnected',
      statusEventId: 'status-1',
    });
    expect(result).toEqual(
      expect.objectContaining({
        event_type: 'task_status_update',
        task_id: 'task-1',
        status: 'running',
      }),
    );
    expect(urls).toEqual([
      'https://backend.local/agent/events',
      'https://backend.local/api/agent/events',
    ]);
  });

  test('commitTaskStopAck posts durable stop acknowledgment payload', async () => {
    const fetchImpl: FetchFn = async (url, init) => {
      expect(String(url)).toBe('https://backend.local/agent/events');
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      expect(body).toEqual({
        agent_host: 'conductor-fire-test',
        events: [
          {
            event_type: 'task_stop_ack',
            task_id: 'task-1',
            request_id: 'req-stop-1',
            accepted: true,
          },
        ],
      });
      return new Response(
        JSON.stringify({
          results: [{ event_type: 'task_stop_ack', task_id: 'task-1', request_id: 'req-stop-1', accepted: true, duplicate: false }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    const result = await client.commitTaskStopAck({
      agentHost: 'conductor-fire-test',
      taskId: 'task-1',
      requestId: 'req-stop-1',
      accepted: true,
    });
    expect(result).toEqual(
      expect.objectContaining({
        event_type: 'task_stop_ack',
        task_id: 'task-1',
        request_id: 'req-stop-1',
        accepted: true,
      }),
    );
  });
});

describe('BackendApiClient scheduled-message actor attribution', () => {
  const previous = process.env.CONDUCTOR_LAUNCHED_BY_DAEMON;
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CONDUCTOR_LAUNCHED_BY_DAEMON;
    } else {
      process.env.CONDUCTOR_LAUNCHED_BY_DAEMON = previous;
    }
  });

  const okResponse = () =>
    new Response(JSON.stringify({ id: 'sched-1', schedules: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  test('marks every schedule op with X-Conductor-Actor when launched by the daemon', async () => {
    process.env.CONDUCTOR_LAUNCHED_BY_DAEMON = '1';
    const seen: Array<Record<string, string> | undefined> = [];
    const fetchImpl: FetchFn = async (_url, init) => {
      seen.push(init?.headers as Record<string, string> | undefined);
      return okResponse();
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    await client.createScheduledMessage('task-1', {
      content: 'ping',
      schedule: { mode: 'delay', amount: 5, unit: 'minute' },
    });
    await client.listScheduledMessages('task-1');
    await client.deleteScheduledMessage('task-1', 'sched-1');

    expect(seen).toHaveLength(3);
    for (const headers of seen) {
      expect(headers).toMatchObject({
        Authorization: 'Bearer token',
        'X-Conductor-Actor': 'agent',
      });
    }
  });

  test('omits the actor header for ordinary (non-daemon) callers', async () => {
    delete process.env.CONDUCTOR_LAUNCHED_BY_DAEMON;
    let headers: Record<string, string> | undefined;
    const fetchImpl: FetchFn = async (_url, init) => {
      headers = init?.headers as Record<string, string> | undefined;
      return okResponse();
    };
    const client = new BackendApiClient(makeConfig(), { fetchImpl });
    await client.listScheduledMessages('task-1');

    expect(headers).toMatchObject({ Authorization: 'Bearer token' });
    expect(headers && 'X-Conductor-Actor' in headers).toBe(false);
  });
});

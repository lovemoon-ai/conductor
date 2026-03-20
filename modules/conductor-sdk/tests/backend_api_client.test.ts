import { describe, expect, test } from 'vitest';

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
          { id: 'p1', name: 'Demo', description: 'Project' },
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

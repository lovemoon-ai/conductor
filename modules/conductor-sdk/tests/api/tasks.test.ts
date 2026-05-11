import { describe, expect, test } from 'vitest';

import { TasksApi } from '../../src/api/index.js';
import { BackendApiError, TaskSummary } from '../../src/backend/index.js';

interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  status: string;
  issueId?: string | null;
}

class FakeApiClient {
  tasks: TaskRecord[] = [];
  postTaskMessageCalls: Array<{ id: string; body: any }> = [];
  listTaskMessagesCalls: Array<{ id: string; params: any }> = [];

  async listTasks(params: { projectId?: string; status?: string }) {
    let result = this.tasks.slice();
    if (params.projectId) {
      result = result.filter((task) => task.projectId === params.projectId);
    }
    return result.map((task) =>
      Object.assign(
        TaskSummary.fromJSON({
          id: task.id,
          project_id: task.projectId,
          title: task.title,
          status: task.status,
        }),
        {
          asObject: () => ({
            id: task.id,
            projectId: task.projectId,
            issueId: task.issueId ?? null,
            title: task.title,
            status: task.status,
          }),
        },
      ),
    );
  }

  async getTask(taskId: string) {
    const found = this.tasks.find((task) => task.id === taskId);
    if (!found) {
      throw new BackendApiError('not found', 404, { error: 'Not found' });
    }
    const summary = TaskSummary.fromJSON({
      id: found.id,
      project_id: found.projectId,
      title: found.title,
      status: found.status,
    });
    return Object.assign(summary, {
      asObject: () => ({
        id: found.id,
        projectId: found.projectId,
        issueId: found.issueId ?? null,
        title: found.title,
        status: found.status,
      }),
    });
  }

  async listTaskMessages(taskId: string, params: { limit?: number; before?: string } = {}) {
    this.listTaskMessagesCalls.push({ id: taskId, params });
    return [
      { id: 'm1', task_id: taskId, role: 'user', content: 'hi', created_at: '2026-01-01T00:00:00Z' },
      { id: 'm2', task_id: taskId, role: 'assistant', content: 'yo', created_at: '2026-01-01T00:00:01Z' },
    ];
  }

  async postTaskMessage(taskId: string, body: any) {
    this.postTaskMessageCalls.push({ id: taskId, body });
    return {
      id: 'msg-new',
      task_id: taskId,
      role: body.role ?? 'sdk',
      content: body.content,
      metadata: body.metadata,
      created_at: '2026-01-01T00:00:02Z',
    };
  }
}

const makeApi = (tasks: TaskRecord[] = []) => {
  const client = new FakeApiClient();
  client.tasks = tasks.map((task) => ({ ...task }));
  const api = new TasksApi(client as any, { sdkVersion: '0.0.0-test', env: {} });
  return { client, api };
};

describe('TasksApi', () => {
  test('listTasks normalizes summary records', async () => {
    const { api } = makeApi([
      { id: 't1', projectId: 'p1', title: 'A', status: 'running' },
      { id: 't2', projectId: 'p1', title: 'B', status: 'completed' },
    ]);
    const tasks = await api.listTasks({ projectId: 'p1' });
    expect(tasks.map((task) => task.id)).toEqual(['t1', 't2']);
    expect(tasks[0].projectId).toBe('p1');
  });

  test('listTasks filters by issueId client-side', async () => {
    const { api } = makeApi([
      { id: 't1', projectId: 'p1', title: 'A', status: 'running', issueId: 'i1' },
      { id: 't2', projectId: 'p1', title: 'B', status: 'running', issueId: 'i2' },
    ]);
    const tasks = await api.listTasks({ projectId: 'p1', issueId: 'i1' });
    expect(tasks.map((task) => task.id)).toEqual(['t1']);
  });

  test('listTasks filters by status (single + array)', async () => {
    const { api } = makeApi([
      { id: 't1', projectId: 'p1', title: 'A', status: 'running' },
      { id: 't2', projectId: 'p1', title: 'B', status: 'completed' },
      { id: 't3', projectId: 'p1', title: 'C', status: 'killed' },
    ]);
    const single = await api.listTasks({ status: 'running' });
    expect(single.map((task) => task.id)).toEqual(['t1']);
    const multi = await api.listTasks({ status: ['running', 'completed'] });
    expect(multi.map((task) => task.id).sort()).toEqual(['t1', 't2']);
  });

  test('getTask returns normalized record', async () => {
    const { api } = makeApi([{ id: 't1', projectId: 'p1', title: 'A', status: 'running' }]);
    const task = await api.getTask('t1');
    expect(task.id).toBe('t1');
    expect(task.status).toBe('running');
  });

  test('getTask maps 404 to BackendApiError', async () => {
    const { api } = makeApi();
    await expect(api.getTask('missing')).rejects.toBeInstanceOf(BackendApiError);
  });

  test('sendTaskMessage POSTs with audit metadata under audit namespace', async () => {
    const { client, api } = makeApi();
    const message = await api.sendTaskMessage('t1', 'hello there', {
      metadata: { source: 'cli' },
      clientRequestId: 'req-1',
    });
    expect(message.id).toBe('msg-new');
    expect(message.content).toBe('hello there');
    const sent = client.postTaskMessageCalls[0];
    expect(sent.id).toBe('t1');
    expect(sent.body.content).toBe('hello there');
    expect(sent.body.metadata).toMatchObject({
      source: 'cli',
      clientRequestId: 'req-1',
      audit: {
        actor: 'sdk',
        sdkVersion: '0.0.0-test',
        invokedBy: null,
      },
    });
    // Audit fields must NOT leak to the top level (review M3 / H1).
    expect(sent.body.metadata.actor).toBeUndefined();
  });

  test('sendTaskMessage forwards role override', async () => {
    const { client, api } = makeApi();
    await api.sendTaskMessage('t1', 'hi', { role: 'system' });
    expect(client.postTaskMessageCalls[0].body.role).toBe('system');
  });

  test('sendTaskMessage rejects empty content', async () => {
    const { api } = makeApi();
    await expect(api.sendTaskMessage('t1', '')).rejects.toThrow(/content/);
  });

  test('listTaskMessages forwards pagination params', async () => {
    const { client, api } = makeApi();
    const messages = await api.listTaskMessages('t1', { limit: 5, before: 'm-prev' });
    expect(messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(client.listTaskMessagesCalls[0]).toEqual({
      id: 't1',
      params: { limit: 5, before: 'm-prev' },
    });
  });
});

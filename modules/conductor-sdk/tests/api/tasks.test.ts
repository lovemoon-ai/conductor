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
  createScheduledMessageCalls: Array<{ id: string; body: any }> = [];
  deleteScheduledMessageCalls: Array<{ taskId: string; scheduleId: string }> = [];
  getTaskGroupCalls: string[] = [];
  taskGroupPayload: Record<string, any> = {
    group_id: null,
    members: [],
  };

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

  async getTaskGroup(taskId: string) {
    this.getTaskGroupCalls.push(taskId);
    return this.taskGroupPayload;
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

  async listScheduledMessages(taskId: string) {
    return [
      {
        id: 'sched-1',
        task_id: taskId,
        source_message_id: null,
        content: 'later',
        kind: 'once_delay',
        condition: 'none',
        interval_ms: null,
        timezone: null,
        status: 'active',
        next_run_at: '2026-01-01T01:00:00Z',
        run_count: 0,
        skip_count: 0,
        failure_count: 0,
        max_runs: null,
        max_skips: null,
        stop_at: null,
        stop_when_task_not_running: true,
        last_run_at: null,
        last_error: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ];
  }

  async createScheduledMessage(taskId: string, body: any) {
    this.createScheduledMessageCalls.push({ id: taskId, body });
    return {
      id: 'sched-new',
      task_id: taskId,
      source_message_id: body.sourceMessageId ?? null,
      content: body.content,
      kind: body.schedule.mode === 'interval' ? 'interval' : 'once_delay',
      condition: body.schedule.condition ?? 'none',
      interval_ms: null,
      timezone: null,
      status: 'active',
      next_run_at: '2026-01-01T01:00:00Z',
      run_count: 0,
      skip_count: 0,
      failure_count: 0,
      max_runs: null,
      max_skips: null,
      stop_at: null,
      stop_when_task_not_running: true,
      last_run_at: null,
      last_error: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
  }

  async deleteScheduledMessage(taskId: string, scheduleId: string) {
    this.deleteScheduledMessageCalls.push({ taskId, scheduleId });
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

  test('getTaskGroup normalizes snake_case group members', async () => {
    const { client, api } = makeApi();
    client.taskGroupPayload = {
      group_id: 'group-1',
      members: [
        {
          task_id: 'worker-1',
          role: 'worker',
          agent: 'feature-dev',
          title: 'Build it',
          status: 'running',
          backend_type: 'codex',
          is_self: true,
        },
      ],
    };

    await expect(api.getTaskGroup(' worker-1 ')).resolves.toEqual({
      groupId: 'group-1',
      members: [
        {
          taskId: 'worker-1',
          role: 'worker',
          agent: 'feature-dev',
          title: 'Build it',
          status: 'running',
          backendType: 'codex',
          isSelf: true,
        },
      ],
    });
    expect(client.getTaskGroupCalls).toEqual(['worker-1']);
  });

  test('getTaskGroup rejects an empty task id', async () => {
    const { client, api } = makeApi();
    await expect(api.getTaskGroup('   ')).rejects.toThrow(/taskId is required/);
    expect(client.getTaskGroupCalls).toEqual([]);
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

  test('scheduled message helpers wrap list/create/delete endpoints', async () => {
    const { client, api } = makeApi();

    const listed = await api.listScheduledMessages('t1');
    expect(listed[0]).toMatchObject({
      id: 'sched-1',
      taskId: 't1',
      status: 'active',
      content: 'later',
    });

    const created = await api.createScheduledMessage('t1', {
      content: '  run later  ',
      sourceMessageId: 'm1',
      schedule: { mode: 'delay', amount: 10, unit: 'minute' },
    });
    expect(created.id).toBe('sched-new');
    expect(client.createScheduledMessageCalls[0]).toEqual({
      id: 't1',
      body: {
        content: 'run later',
        sourceMessageId: 'm1',
        schedule: { mode: 'delay', amount: 10, unit: 'minute' },
      },
    });

    await api.deleteScheduledMessage('t1', 'sched-1');
    expect(client.deleteScheduledMessageCalls[0]).toEqual({
      taskId: 't1',
      scheduleId: 'sched-1',
    });
  });
});

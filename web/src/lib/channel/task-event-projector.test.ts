import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    broadcast: vi.fn(),
    notifyTaskStatus: vi.fn(),
  },
}));

vi.mock('./outbox', () => ({
  enqueueProjectedTaskUpdate: vi.fn(),
}));

const { realtimeHub } = await import('@/lib/realtime/hub');
const { enqueueProjectedTaskUpdate } = await import('./outbox');
const { projectTaskMessage, projectTaskStatusUpdate } = await import('./task-event-projector');

describe('task-event-projector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts task message payloads with normalized metadata and attachments', async () => {
    await projectTaskMessage({
      userId: 'user-1',
      projectId: 'proj-1',
      message: {
        id: 'msg-1',
        taskId: 'task-1',
        role: 'sdk',
        content: 'hello',
        metadata: {
          attachments: [
            {
              id: 'att-1',
              name: 'log.txt',
              mimeType: 'text/plain',
              sizeBytes: 12,
              downloadUrl: '/api/tasks/task-1/attachments/att-1',
            },
          ],
        },
        createdAt: new Date('2026-03-16T00:00:00.000Z'),
      },
    });

    expect(realtimeHub.broadcast).toHaveBeenCalledWith('user-1', 'proj-1', {
      type: 'task_sdk_message',
      payload: expect.objectContaining({
        id: 'msg-1',
        task_id: 'task-1',
        project_id: 'proj-1',
        role: 'sdk',
        content: 'hello',
        metadata: expect.objectContaining({
          attachments: expect.any(Array),
        }),
        attachments: [
          expect.objectContaining({
            id: 'att-1',
            name: 'log.txt',
          }),
        ],
      }),
    });
    expect(enqueueProjectedTaskUpdate).toHaveBeenCalledWith({
      userId: 'user-1',
      taskId: 'task-1',
      kind: 'assistant_message',
      text: 'hello',
    });
  });

  it('broadcasts terminal task status updates and notifies waiters', async () => {
    await projectTaskStatusUpdate({
      userId: 'user-1',
      projectId: 'proj-1',
      taskId: 'task-1',
      status: 'killed',
      summary: 'Recovered after timeout',
    });

    expect(realtimeHub.notifyTaskStatus).toHaveBeenCalledWith('task-1', 'killed');
    expect(realtimeHub.broadcast).toHaveBeenCalledWith('user-1', 'proj-1', {
      type: 'task_status_update',
      payload: {
        task_id: 'task-1',
        project_id: 'proj-1',
        status: 'killed',
        summary: 'Recovered after timeout',
      },
    });
    expect(enqueueProjectedTaskUpdate).toHaveBeenCalledWith({
      userId: 'user-1',
      taskId: 'task-1',
      kind: 'task_status',
      text: 'Task task-1 is now killed: Recovered after timeout',
    });
  });
});

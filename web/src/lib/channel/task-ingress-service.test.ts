import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    project: { findFirst: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    message: { create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    bindTaskToAgent: vi.fn(),
    getTaskAgentHost: vi.fn(),
    sendToAgentHost: vi.fn(),
  },
}));

vi.mock('@/lib/realtime/agent-outbox', () => ({
  enqueueAndAttemptAgentCommand: vi.fn(),
}));

vi.mock('@/lib/subscription/plan-limits', () => ({
  countActiveTaskBuckets: vi.fn(),
  exceedsTaskLimit: vi.fn(),
  getTaskLimitMessage: vi.fn(),
  getTaskPlanBucket: vi.fn(),
  isConductorFireHost: vi.fn((host: string) => host.startsWith('conductor-fire-')),
}));

vi.mock('./task-event-projector', () => ({
  projectTaskMessage: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { realtimeHub } = await import('@/lib/realtime/hub');
const { enqueueAndAttemptAgentCommand } = await import('@/lib/realtime/agent-outbox');
const {
  countActiveTaskBuckets,
  exceedsTaskLimit,
  getTaskLimitMessage,
  getTaskPlanBucket,
} = await import('@/lib/subscription/plan-limits');
const { projectTaskMessage } = await import('./task-event-projector');
const {
  createTaskForUser,
  appendUserMessageToTask,
  TaskIngressError,
} = await import('./task-ingress-service');

describe('task-ingress-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'proj-1', userId: 'user-1' } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue({ subscriptionTier: 'PLUS' } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(countActiveTaskBuckets).mockReturnValue({ app: 0, manual_fire: 0 } as any);
    vi.mocked(getTaskPlanBucket).mockReturnValue('app' as any);
    vi.mocked(exceedsTaskLimit).mockReturnValue(false);
    vi.mocked(getTaskLimitMessage).mockReturnValue('limit');
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
    ] as any);
    vi.mocked(db.task.create).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      title: 'New Task',
      status: 'unknown',
      agentHost: 'daemon-a',
      executionHost: 'daemon-a',
      backendType: 'claude',
      sessionId: null,
      sessionFilePath: null,
      metadata: JSON.stringify({ backendType: 'claude', initialContent: 'hello' }),
      createdAt: new Date('2026-03-16T00:00:00.000Z'),
      updatedAt: new Date('2026-03-16T00:00:00.000Z'),
    } as any);
    vi.mocked(db.message.create).mockResolvedValue({
      id: 'msg-1',
      taskId: 'task-1',
      role: 'user',
      content: 'hello',
      createdAt: new Date('2026-03-16T00:00:01.000Z'),
    } as any);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({ requestId: 'req-1', delivered: false } as any);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('conductor-fire-runtime');
  });

  it('creates a task with initial content, projects the initial user message, and enqueues create_task', async () => {
    const result = await createTaskForUser({
      userId: 'user-1',
      projectId: 'proj-1',
      backendType: 'claude',
      metadata: { initialContent: 'hello' },
    });

    expect(result.task.id).toBe('task-1');
    expect(db.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'proj-1',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
      }),
    }));
    expect(projectTaskMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      projectId: 'proj-1',
      message: expect.objectContaining({
        id: 'msg-1',
        role: 'user',
        content: 'hello',
      }),
    }));
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith('task-1', 'daemon-a');
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        agentHost: 'daemon-a',
        taskId: 'task-1',
        eventType: 'create_task',
      }),
      expect.any(Object),
    );
  });

  it('appends a user message and routes task_user_message to the active fire host', async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      agentHost: 'conductor-fire-fallback',
      executionHost: 'conductor-fire-runtime',
    } as any);

    const result = await appendUserMessageToTask({
      userId: 'user-1',
      taskId: 'task-1',
      content: 'continue',
      metadata: { source: 'web' },
    });

    expect(result.message.id).toBe('msg-1');
    expect(projectTaskMessage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      projectId: 'proj-1',
      message: expect.objectContaining({
        id: 'msg-1',
      }),
    }));
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHost: 'conductor-fire-runtime',
        eventType: 'task_user_message',
      }),
      expect.objectContaining({
        agentHost: 'conductor-fire-runtime',
      }),
    );
  });

  it('throws a task limit error with current route message semantics', async () => {
    vi.mocked(exceedsTaskLimit).mockReturnValue(true);

    await expect(
      createTaskForUser({
        userId: 'user-1',
        projectId: 'proj-1',
      }),
    ).rejects.toMatchObject({
      name: 'TaskIngressError',
      code: 'TASK_LIMIT_REACHED',
      status: 403,
      details: expect.objectContaining({
        error: 'Task limit reached',
      }),
    });
  });
});

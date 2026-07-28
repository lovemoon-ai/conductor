import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    project: { findFirst: vi.fn() },
    task: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    message: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
    user: { findUnique: vi.fn() },
    attachedTerminal: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
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
  isConductorFireHost: vi.fn((host: string) => host.startsWith('conductor-fire-')),
}));

vi.mock('./task-event-projector', () => ({
  projectTaskMessage: vi.fn(),
}));

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

const { db } = await import('@/lib/db');
const { realtimeHub } = await import('@/lib/realtime/hub');
const { enqueueAndAttemptAgentCommand } = await import('@/lib/realtime/agent-outbox');
const { projectTaskMessage } = await import('./task-event-projector');
const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const {
  createTaskForUser,
  appendUserMessageToTask,
  TaskIngressError,
} = await import('./task-ingress-service');
const { GET: getTasksRoute } = await import('@/app/api/tasks/route');

describe('task-ingress-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      daemonHost: 'daemon-a',
      workspacePath: '/repo/project',
      worktreeBranch: 'main',
    } as any);
    vi.mocked(db.user.findUnique).mockResolvedValue({ subscriptionTier: 'PLUS' } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.$transaction).mockImplementation(async (operations: any) => {
      if (Array.isArray(operations)) {
        return Promise.all(operations);
      }
      return operations;
    });
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-2', host: 'daemon-b', supportedBackends: ['claude'] },
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
      launchConfig: JSON.stringify({
        backendType: 'claude',
        cwd: '/repo/project',
        worktreeBranch: 'main',
      }),
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
    vi.mocked(db.message.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: 'task-1',
      updatedAt: new Date('2026-03-16T00:00:01.000Z'),
    } as any);
    vi.mocked(enqueueAndAttemptAgentCommand).mockResolvedValue({ requestId: 'req-1', delivered: false } as any);
    vi.mocked(realtimeHub.sendToAgentHost).mockReturnValue(true);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('conductor-fire-runtime');
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: 'user-1',
      email: 'test@example.com',
      phone: null,
    } as any);
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
    expect(db.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        launchConfig: JSON.stringify({
          backendType: 'claude',
          cwd: '/repo/project',
          worktreeBranch: 'main',
        }),
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
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1' },
        data: expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
      }),
    );
    expect(realtimeHub.bindTaskToAgent).toHaveBeenCalledWith('task-1', 'daemon-a');
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        agentHost: 'daemon-a',
        taskId: 'task-1',
        eventType: 'create_task',
        envelope: expect.objectContaining({
          type: 'create_task',
          payload: expect.objectContaining({
            launch_config: {
              backendType: 'claude',
              cwd: '/repo/project',
              worktreeBranch: 'main',
            },
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('overrides an explicitly requested daemon with the project bound daemon', async () => {
    await createTaskForUser({
      userId: 'user-1',
      projectId: 'proj-1',
      agentHost: 'daemon-b',
      backendType: 'claude',
      metadata: { initialContent: 'hello' },
    });

    expect(db.task.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
      }),
    }));
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHost: 'daemon-a',
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
      role: 'user',
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
    expect(db.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'task-1' },
        data: expect.objectContaining({
          updatedAt: expect.any(Date),
        }),
      }),
    );
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

  it('keeps archived transcripts read-only even when a stale fire owner remains persisted', async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      agentHost: 'daemon-a',
      executionHost: 'conductor-fire-runtime',
      achievedAt: new Date('2026-07-27T00:00:00.000Z'),
    } as any);

    await expect(
      appendUserMessageToTask({
        userId: 'user-1',
        taskId: 'task-1',
        content: 'late message',
        role: 'user',
      }),
    ).rejects.toMatchObject({
      code: 'TASK_ARCHIVED',
      status: 409,
      details: {
        error: 'Task archived',
      },
    });

    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.task.update).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it('reuses an existing client message id and still enqueues the user message command', async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      agentHost: 'conductor-fire-fallback',
      executionHost: 'conductor-fire-runtime',
    } as any);
    vi.mocked(db.message.create).mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );
    vi.mocked(db.message.findFirst).mockResolvedValue({
      id: 'msg-existing',
      taskId: 'task-1',
      role: 'user',
      content: 'scheduled retry',
      metadata: JSON.stringify({ scheduledMessageId: 'sched-1' }),
      clientMessageId: 'scheduled-message:sched-1:1',
      createdAt: new Date('2026-03-16T00:00:01.000Z'),
    } as any);

    const result = await appendUserMessageToTask({
      userId: 'user-1',
      taskId: 'task-1',
      content: 'scheduled retry',
      role: 'user',
      clientMessageId: 'scheduled-message:sched-1:1',
      metadata: { scheduledMessageId: 'sched-1' },
    });

    expect(result.message.id).toBe('msg-existing');
    expect(projectTaskMessage).not.toHaveBeenCalled();
    expect(db.message.findFirst).toHaveBeenCalledWith({
      where: {
        taskId: 'task-1',
        clientMessageId: 'scheduled-message:sched-1:1',
      },
    });
    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHost: 'conductor-fire-runtime',
        eventType: 'task_user_message',
        requestId: 'msg-existing',
        envelope: expect.objectContaining({
          payload: expect.objectContaining({
            message_id: 'msg-existing',
            content: 'scheduled retry',
          }),
        }),
      }),
      expect.objectContaining({
        agentHost: 'conductor-fire-runtime',
      }),
    );
  });

  it('ignores a stale bound fire host when an app task has a runtime fire owner', async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      agentHost: 'daemon-a',
      executionHost: 'conductor-fire-runtime',
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('conductor-fire-stale');

    await appendUserMessageToTask({
      userId: 'user-1',
      taskId: 'task-1',
      content: 'continue',
      role: 'user',
    });

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

  it('keeps manual fire user messages on the persisted fire owner when the bound host is stale', async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      agentHost: 'conductor-fire-manual',
      executionHost: 'conductor-fire-manual',
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('conductor-fire-stale');

    await appendUserMessageToTask({
      userId: 'user-1',
      taskId: 'task-1',
      content: 'continue',
      role: 'user',
    });

    expect(enqueueAndAttemptAgentCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentHost: 'conductor-fire-manual',
        eventType: 'task_user_message',
      }),
      expect.objectContaining({
        agentHost: 'conductor-fire-manual',
      }),
    );
  });

  it('rejects a user message for an app task without a runtime fire owner', async () => {
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-1',
      projectId: 'proj-1',
      agentHost: 'daemon-a',
      executionHost: null,
    } as any);
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('conductor-fire-stale');

    await expect(
      appendUserMessageToTask({
        userId: 'user-1',
        taskId: 'task-1',
        content: 'continue',
        role: 'user',
      }),
    ).rejects.toMatchObject({
      code: 'TASK_MISSING_ACTIVE_FIRE_OWNER',
      status: 409,
      details: {
        code: 'task_missing_active_fire_owner',
        error: 'Task missing active fire owner',
      },
    });

    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.task.update).not.toHaveBeenCalled();
    expect(projectTaskMessage).not.toHaveBeenCalled();
    expect(enqueueAndAttemptAgentCommand).not.toHaveBeenCalled();
  });

  it('keeps a freshly updated task at the top on a fresh /api/tasks read after message activity', async () => {
    const now = Date.now();
    const taskRows = [
      {
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Older task',
        status: 'running',
        agentHost: 'conductor-fire-runtime',
        executionHost: 'conductor-fire-runtime',
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        ptySession: null,
        createdAt: new Date(now - 10 * 60 * 1000),
        updatedAt: new Date(now - 10 * 60 * 1000),
      },
      {
        id: 'task-2',
        projectId: 'proj-1',
        title: 'Newer but idle',
        status: 'running',
        agentHost: 'conductor-fire-runtime',
        executionHost: 'conductor-fire-runtime',
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        metadata: null,
        ptySession: null,
        createdAt: new Date(now - 5 * 60 * 1000),
        updatedAt: new Date(now - 5 * 60 * 1000),
      },
    ];
    const messages: any[] = [];

    vi.mocked(db.task.findFirst).mockImplementation(async ({ where }: any) => (
      taskRows.find((task) => task.id === where.id) ?? null
    ) as any);
    vi.mocked(db.task.findMany).mockImplementation(async () => taskRows as any);
    vi.mocked(db.task.update).mockImplementation(async ({ where, data }: any) => {
      const task = taskRows.find((item) => item.id === where.id);
      if (!task) {
        throw new Error(`task ${where.id} not found`);
      }
      task.updatedAt = data.updatedAt;
      return task as any;
    });
    vi.mocked(db.message.create).mockImplementation(async ({ data }: any) => {
      const message = {
        id: `msg-${messages.length + 1}`,
        taskId: data.taskId,
        role: data.role,
        content: data.content,
        metadata: data.metadata ?? null,
        createdAt: new Date(now),
      };
      messages.push(message);
      return message as any;
    });
    vi.mocked(db.message.findMany).mockImplementation(async ({ where }: any) => {
      const taskIds = new Set(where.taskId.in);
      const roles = new Set(where.role.in);
      return messages
        .filter((message) => taskIds.has(message.taskId) && roles.has(message.role))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime()) as any;
    });

    await appendUserMessageToTask({
      userId: 'user-1',
      taskId: 'task-1',
      content: 'fresh prompt',
      role: 'user',
    });

    const response = await getTasksRoute(new NextRequest('http://localhost:6152/api/tasks'));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.map((task: { id: string }) => task.id)).toEqual(['task-1', 'task-2']);
    expect(data[0]).toMatchObject({
      id: 'task-1',
      last_user_message: 'fresh prompt',
    });
  });
});

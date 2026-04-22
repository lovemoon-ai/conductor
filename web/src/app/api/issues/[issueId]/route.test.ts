import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, PATCH } from './route';
import { createMockRequest, extractJson } from '@/__tests__/helpers';

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: vi.fn(),
    issue: {
      aggregate: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    agentOutbox: {
      create: vi.fn(),
    },
    defaultProject: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/tasks/create-ai-task', () => ({
  createAiTaskArtifacts: vi.fn(),
  finalizeAiTaskCreation: vi.fn(),
}));

vi.mock('@/lib/tasks/task-stop', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/lib/tasks/task-stop')>();
  return {
    ...mod,
    stopTaskBeforeRelaunch: vi.fn(),
  };
});

vi.mock('@/lib/realtime/agent-outbox', () => ({
  deliverAgentOutboxForHost: vi.fn().mockResolvedValue({ attempted: 1, delivered: 1 }),
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    getTaskAgentHost: vi.fn(),
    bindTaskToAgent: vi.fn(),
    sendToAgentHost: vi.fn().mockReturnValue(true),
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');
const { createAiTaskArtifacts, finalizeAiTaskCreation } = await import('@/lib/tasks/create-ai-task');
const { stopTaskBeforeRelaunch } = await import('@/lib/tasks/task-stop');
const { realtimeHub } = await import('@/lib/realtime/hub');
const { deliverAgentOutboxForHost } = await import('@/lib/realtime/agent-outbox');

const missingPriorityColumnError = () =>
  new Prisma.PrismaClientKnownRequestError(
    'The column `issues.priority` does not exist in the current database.',
    {
      code: 'P2022',
      clientVersion: 'test',
    },
  );

const buildExistingIssue = (overrides: Record<string, unknown> = {}) => ({
  id: 'issue-1',
  projectId: 'project-1',
  title: 'Board implementation',
  description: 'Hook issue board into the app shell',
  status: 'todo',
  priority: 'P1',
  position: 1,
  metadata: null,
  createdAt: new Date('2026-04-14T00:00:00.000Z'),
  updatedAt: new Date('2026-04-14T00:10:00.000Z'),
  tasks: [],
  project: {
    id: 'project-1',
    daemonHost: null,
    workspacePath: null,
    repoRoot: null,
    worktreeBranch: null,
    lastCommit: null,
  },
  ...overrides,
});

const buildTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-active',
  projectId: 'project-1',
  issueId: 'issue-1',
  title: 'Existing active task',
  status: 'running',
  taskType: 'ai_task',
  agentHost: 'daemon-a',
  executionHost: 'daemon-a',
  backendType: 'codex',
  sessionId: 'sess-1',
  sessionFilePath: '/tmp/sess-1.jsonl',
  launchConfig: null,
  metadata: null,
  createdAt: new Date('2026-04-14T00:15:00.000Z'),
  updatedAt: new Date('2026-04-14T00:25:00.000Z'),
  ...overrides,
});

const mockIssueTasks = ({
  activeTasks = [],
  linkedTasks = [],
}: {
  activeTasks?: Record<string, unknown>[];
  linkedTasks?: Record<string, unknown>[];
}) => {
  vi.mocked(db.task.findMany)
    .mockResolvedValueOnce(activeTasks as any)
    .mockResolvedValueOnce(linkedTasks as any);
};

describe('/api/issues/[issueId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-1' } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === 'function'
        ? callback({ issue: db.issue, task: db.task, agentOutbox: db.agentOutbox })
        : callback,
    );
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue({ projectId: 'project-1' } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: 4 } } as any);
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({ status: 'doing', tasks: [] }) as any);
    vi.mocked(db.issue.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.task.findFirst).mockResolvedValue(buildTask({
      status: 'killed',
      executionHost: null,
    }) as any);
    vi.mocked(db.task.update).mockImplementation(async ({ where, data }: any) => ({
      ...buildTask(),
      id: where.id,
      ...data,
      updatedAt: new Date('2026-04-14T00:25:00.000Z'),
    }) as any);
    vi.mocked(db.agentOutbox.create).mockResolvedValue({ id: 'outbox-1' } as any);
    vi.mocked(db.issue.delete).mockResolvedValue({ id: 'issue-1' } as any);
    vi.mocked(finalizeAiTaskCreation).mockResolvedValue(undefined);
    vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: true });
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
  });

  it('returns the latest linked task on issue detail even when it is historical', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'done' }) as any);
    mockIssueTasks({
      activeTasks: [],
      linkedTasks: [buildTask({ status: 'killed', executionHost: null })],
    });

    const response = await GET(createMockRequest({ method: 'GET' }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-1',
      active_task: null,
      linked_task: expect.objectContaining({
        id: 'task-active',
        status: 'killed',
        issue_id: 'issue-1',
      }),
    }));
  });

  it('returns persisted non-default priority on issue detail', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      status: 'done',
      priority: 'P0',
    }) as any);
    mockIssueTasks({
      activeTasks: [],
      linkedTasks: [],
    });

    const response = await GET(createMockRequest({ method: 'GET' }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-1',
      priority: 'P0',
    }));
  });

  it('falls back to default priority on issue detail when the priority column is missing', async () => {
    vi.mocked(db.issue.findFirst)
      .mockRejectedValueOnce(missingPriorityColumnError())
      .mockResolvedValueOnce(buildExistingIssue({ priority: undefined }) as any);
    mockIssueTasks({
      activeTasks: [],
      linkedTasks: [],
    });

    const response = await GET(createMockRequest({ method: 'GET' }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(vi.mocked(db.issue.findFirst)).toHaveBeenCalledTimes(2);
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-1',
      priority: 'P1',
    }));
  });

  it('spawns an AI task only when transitioning from todo to doing', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: null,
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Board implementation',
    }), expect.any(Object));
    expect(finalizeAiTaskCreation).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({
        id: 'task-1',
        issueId: 'issue-1',
      }),
    }));
    expect(data.activeTask).toEqual(expect.objectContaining({
      id: 'task-1',
      issue_id: 'issue-1',
    }));
    expect(data.spawnedTask).toEqual(expect.objectContaining({
      id: 'task-1',
      issue_id: 'issue-1',
    }));
  });

  it('spawns todo-to-doing tasks in an isolated worktree for git-backed bound projects', async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a' },
    ] as any);
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      project: {
        id: 'project-1',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/packages/web',
        repoRoot: '/repo',
        worktreeBranch: 'main',
        lastCommit: 'abc123',
      },
    }) as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-worktree',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    const createArgs = vi.mocked(createAiTaskArtifacts).mock.calls[0][0] as any;
    expect(createArgs).toEqual(expect.objectContaining({
      requestedId: expect.any(String),
      agentHost: 'daemon-a',
    }));
    expect(createArgs.launchConfig).toEqual(expect.objectContaining({
      worktree: true,
      worktreeId: createArgs.requestedId,
      worktreeBranch: expect.stringMatching(/^[0-9a-f]{6}$/),
      worktreeBaseRef: 'main',
      projectRepoRoot: '/repo',
      projectWorkspacePath: '/repo/packages/web',
      projectRelativePath: 'packages/web',
    }));
  });

  it('restarts the linked stopped task when moving a done issue back to doing', async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['codex'] },
    ] as any);
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'done' }) as any);
    mockIssueTasks({
      activeTasks: [],
      linkedTasks: [buildTask({ status: 'killed' })],
    });
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({ status: 'doing' }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    expect(db.agentOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        taskId: 'task-active',
        eventType: 'restart_task',
        payloadJson: expect.stringContaining('"mode":"resume_inplace"'),
      }),
    }));
    expect(db.task.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'task-active' },
      data: expect.objectContaining({
        status: 'running',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
      }),
    }));
    expect(deliverAgentOutboxForHost).toHaveBeenCalled();
    expect(data.activeTask).toEqual(expect.objectContaining({
      id: 'task-active',
      status: 'running',
    }));
    expect(data.linkedTask).toEqual(expect.objectContaining({
      id: 'task-active',
      status: 'running',
    }));
    expect(data.spawnedTask).toBeNull();
  });

  it('treats legacy backlog as todo when entering doing', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'backlog' }) as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-legacy',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: null,
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(db.issue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'issue-1', status: 'backlog' }),
        data: expect.objectContaining({ status: 'doing' }),
      }),
    );
    expect(createAiTaskArtifacts).toHaveBeenCalled();
  });

  it('maps legacy review patch requests to doing', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    mockIssueTasks({
      activeTasks: [buildTask()],
      linkedTasks: [buildTask()],
    });

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'review' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(db.issue.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'doing',
      }),
    }));
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
  });

  it('updates issue priority through PATCH', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({ priority: 'P0' }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { priority: 'P0' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.issue.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        priority: 'P0',
      }),
    }));
    expect(data.issue).toEqual(expect.objectContaining({
      id: 'issue-1',
      priority: 'P0',
    }));
  });

  it('updates non-priority fields when the priority column is missing', async () => {
    vi.mocked(db.issue.findFirst)
      .mockRejectedValueOnce(missingPriorityColumnError())
      .mockResolvedValueOnce(buildExistingIssue({ priority: undefined }) as any);
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      title: 'Retitled issue',
      priority: undefined,
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { title: 'Retitled issue' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect((vi.mocked(db.issue.update).mock.calls[0]?.[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('priority');
    expect(data.issue).toEqual(expect.objectContaining({
      id: 'issue-1',
      title: 'Retitled issue',
      priority: 'P1',
    }));
  });

  it('returns a migration error when updating to a non-default priority without the priority column', async () => {
    vi.mocked(db.issue.findFirst)
      .mockRejectedValueOnce(missingPriorityColumnError())
      .mockResolvedValueOnce(buildExistingIssue({ priority: undefined }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { priority: 'P0' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Issue priority is unavailable");
    expect(db.issue.update).not.toHaveBeenCalled();
  });

  it('does not spawn a duplicate task when an active linked task already exists', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    mockIssueTasks({
      activeTasks: [buildTask()],
      linkedTasks: [buildTask()],
    });

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
    expect(data.activeTask).toEqual(expect.objectContaining({ id: 'task-active' }));
    expect(data.spawnedTask).toBeNull();
  });

  it('waits for the linked active task to stop before moving a doing issue to done', async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('daemon-a');
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'doing' }) as any);
    mockIssueTasks({
      activeTasks: [buildTask()],
      linkedTasks: [buildTask()],
    });
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      status: 'done',
      tasks: [],
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'done' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      taskId: 'task-active',
      projectId: 'project-1',
      stopTargetHost: 'daemon-a',
      reason: 'issue_done',
    }));
    expect(db.task.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'task-active',
        project: { userId: 'user-1' },
      },
    });
    expect(db.task.update).not.toHaveBeenCalled();
    expect(db.issue.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'done' }),
    }));
    expect(data.issue).toEqual(expect.objectContaining({
      id: 'issue-1',
      status: 'done',
      active_task: null,
      linked_task: expect.objectContaining({
        id: 'task-active',
        status: 'killed',
      }),
    }));
    expect(data.activeTask).toBeNull();
    expect(data.linkedTask).toEqual(expect.objectContaining({
      id: 'task-active',
      status: 'killed',
    }));
    expect(data.killedTask).toEqual(expect.objectContaining({
      id: 'task-active',
      status: 'killed',
      execution_host: null,
    }));
  });

  it('also stops an init linked task before moving a doing issue to done', async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('daemon-a');
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'doing' }) as any);
    mockIssueTasks({
      activeTasks: [buildTask({
        id: 'task-init',
        title: 'Existing init task',
        status: 'init',
      })],
      linkedTasks: [buildTask({
        id: 'task-init',
        title: 'Existing init task',
        status: 'init',
      })],
    });
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      status: 'done',
      tasks: [],
    }) as any);
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: 'task-init',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Existing init task',
      status: 'killed',
      taskType: 'ai_task',
      agentHost: 'daemon-a',
      executionHost: null,
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: null,
      metadata: null,
      createdAt: new Date('2026-04-14T00:15:00.000Z'),
      updatedAt: new Date('2026-04-14T00:25:00.000Z'),
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'done' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      taskId: 'task-init',
      projectId: 'project-1',
      stopTargetHost: 'daemon-a',
      reason: 'issue_done',
    }));
    expect(data.activeTask).toBeNull();
    expect(data.killedTask).toEqual(expect.objectContaining({
      id: 'task-init',
      status: 'killed',
    }));
  });

  it('moves a doing issue to done without writing priority when the priority column is missing', async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('daemon-a');
    vi.mocked(db.issue.findFirst)
      .mockRejectedValueOnce(missingPriorityColumnError())
      .mockResolvedValueOnce(buildExistingIssue({
        status: 'doing',
        priority: undefined,
      }) as any);
    mockIssueTasks({
      activeTasks: [buildTask()],
      linkedTasks: [buildTask()],
    });
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      status: 'done',
      priority: undefined,
      tasks: [],
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'done' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(vi.mocked(db.issue.findFirst)).toHaveBeenCalledTimes(2);
    expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-active',
      stopTargetHost: 'daemon-a',
    }));
    expect((vi.mocked(db.issue.update).mock.calls[0]?.[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('priority');
    expect(data.issue).toEqual(expect.objectContaining({
      id: 'issue-1',
      status: 'done',
      priority: 'P1',
    }));
    expect(data.killedTask).toEqual(expect.objectContaining({
      id: 'task-active',
      status: 'killed',
    }));
  });

  it('prefers a persisted conductor-fire host over a stale daemon binding when stopping an issue task', async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('debug');
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'doing' }) as any);
    mockIssueTasks({
      activeTasks: [buildTask({
        id: 'task-fire',
        title: 'Existing fire task',
        agentHost: 'conductor-fire-unknown-host-21937',
        executionHost: 'conductor-fire-unknown-host-21937',
        metadata: JSON.stringify({ daemonName: 'debug' }),
      })],
      linkedTasks: [buildTask({
        id: 'task-fire',
        title: 'Existing fire task',
        agentHost: 'conductor-fire-unknown-host-21937',
        executionHost: 'conductor-fire-unknown-host-21937',
        metadata: JSON.stringify({ daemonName: 'debug' }),
      })],
    });
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      status: 'done',
      tasks: [],
    }) as any);
    vi.mocked(db.task.findFirst).mockResolvedValueOnce({
      id: 'task-fire',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Existing fire task',
      status: 'killed',
      taskType: 'ai_task',
      agentHost: 'conductor-fire-unknown-host-21937',
      executionHost: null,
      backendType: 'codex',
      sessionId: 'sess-1',
      sessionFilePath: '/tmp/sess-1.jsonl',
      launchConfig: null,
      metadata: JSON.stringify({ daemonName: 'debug' }),
      createdAt: new Date('2026-04-14T00:15:00.000Z'),
      updatedAt: new Date('2026-04-14T00:25:00.000Z'),
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'done' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(stopTaskBeforeRelaunch).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1',
      taskId: 'task-fire',
      projectId: 'project-1',
      stopTargetHost: 'conductor-fire-unknown-host-21937',
      reason: 'issue_done',
    }));
  });

  it('returns 409 when a doing issue task is still active but has no daemon binding', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'doing' }) as any);
    mockIssueTasks({
      activeTasks: [buildTask({
        agentHost: null,
        executionHost: null,
      })],
      linkedTasks: [buildTask({
        agentHost: null,
        executionHost: null,
      })],
    });
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'done' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Issue task missing active daemon binding');
    expect(db.issue.update).not.toHaveBeenCalled();
  });

  it('does not finalize task side effects when the issue update fails inside the transaction', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-1',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: null,
        executionHost: null,
        backendType: null,
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: {
        id: 'message-1',
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);
    vi.mocked(db.issue.update).mockRejectedValueOnce(new Error('issue update failed'));

    await expect(PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    })).rejects.toThrow('issue update failed');

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        issueId: 'issue-1',
      }),
      expect.any(Object),
    );
    expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
  });

  it('deletes the issue without touching tasks', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(204);
    expect(db.issue.delete).toHaveBeenCalledWith({ where: { id: 'issue-1' } });
  });

  it('skips task spawn when another request already claimed the todo-to-doing transition', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    // Simulate concurrent claim: updateMany returns count: 0
    vi.mocked(db.issue.updateMany).mockResolvedValue({ count: 0 } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.issue.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'issue-1', status: 'todo' }),
        data: expect.objectContaining({ status: 'doing' }),
      }),
    );
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    expect(finalizeAiTaskCreation).not.toHaveBeenCalled();
    expect(data.spawnedTask).toBeNull();
  });

});

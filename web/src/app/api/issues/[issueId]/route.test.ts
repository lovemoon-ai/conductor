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
    project: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    collaborationMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
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

const missingAiSessionColumnError = () =>
  new Prisma.PrismaClientKnownRequestError(
    'The column `issues.ai_session_id` does not exist in the current database.',
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
    vi.mocked(db.project.findMany).mockResolvedValue([
      { id: 'project-1', collaborationId: null },
    ] as any);
    vi.mocked(db.project.findFirst).mockImplementation(async ({ where }: any) => ({
      id: where.id ?? 'project-1',
      userId: 'user-1',
      collaborationId: null,
      daemonHost: null,
      workspacePath: null,
      repoRoot: null,
      worktreeBranch: null,
      lastCommit: null,
    }) as any);
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([] as any);
    vi.mocked(db.collaborationMember.findUnique).mockResolvedValue(null as any);
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

  it('passes the selected backend through issue metadata when spawning an AI task', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-backend',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: null,
        executionHost: null,
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: JSON.stringify({ backendType: 'claude' }),
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: {
          backendType: 'claude',
        },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      requestedBackendType: 'claude',
      metadata: expect.objectContaining({
        backendType: 'claude',
        initialContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
      }),
    }), expect.any(Object));
  });

  it('rejects todo-to-doing spawn when the bound daemon does not support the selected backend', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      project: {
        id: 'project-1',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/app',
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
      },
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['codex'] },
    ] as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: {
          backendType: 'claude',
        },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({ error: 'Daemon daemon-a does not support backend claude' });
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
  });

  it('allows todo-to-doing spawn on a bound legacy daemon that does not advertise supported backends', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      project: {
        id: 'project-1',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/app',
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
      },
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: [] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-legacy-bound',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: JSON.stringify({ backendType: 'claude' }),
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: {
          backendType: 'claude',
        },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      agentHost: 'daemon-a',
      requestedBackendType: 'claude',
    }), expect.any(Object));
  });

  it('rejects todo-to-doing spawn when no compatible daemon is online for the selected backend', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['codex'] },
    ] as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: {
          backendType: 'claude',
        },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data).toEqual({ error: 'No compatible daemon online for backend claude' });
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
  });

  it('allows todo-to-doing spawn on an unbound legacy daemon that does not advertise supported backends', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: [] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-legacy-unbound',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: JSON.stringify({ backendType: 'claude' }),
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: {
          backendType: 'claude',
        },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      agentHost: 'daemon-a',
      requestedBackendType: 'claude',
    }), expect.any(Object));
  });

  it('falls back to a legacy unbound daemon when earlier agents explicitly reject the selected backend', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['codex'] },
      { id: 'agent-2', host: 'daemon-b', supportedBackends: [] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-legacy-fallback',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-b',
        executionHost: 'daemon-b',
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: JSON.stringify({ backendType: 'claude' }),
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: {
          backendType: 'claude',
        },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(expect.objectContaining({
      agentHost: 'daemon-b',
      requestedBackendType: 'claude',
    }), expect.any(Object));
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

  it('rejects moving an issue into doing when the current user is not the owner', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      ownerUserId: 'user-2',
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Only the issue owner can move this issue into doing');
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    expect(db.issue.update).not.toHaveBeenCalled();
  });

  it('rejects changing a running issue status when the current user is not the owner', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      ownerUserId: 'user-2',
      status: 'doing',
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'done' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Only the issue owner can change a running issue status');
    expect(stopTaskBeforeRelaunch).not.toHaveBeenCalled();
    expect(db.issue.update).not.toHaveBeenCalled();
  });

  it('rejects ownership reassignment from a non-owner and non-project-owner caller', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      ownerUserId: 'user-2',
      project: {
        id: 'project-1',
        userId: 'user-2',
        collaborationId: 'collab-1',
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
      },
    }) as any);
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
      { userId: 'user-1', projectId: 'project-1' },
      { userId: 'user-2', projectId: 'project-2' },
    ] as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { ownerUserId: 'user-1' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(403);
    expect(data.error).toContain('current issue owner or the project owner');
    expect(db.issue.update).not.toHaveBeenCalled();
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
  });

  it('allows the issue owner to move a collaboration issue to another member project', async () => {
    vi.mocked(db.project.findMany).mockResolvedValue([
      { id: 'project-1', collaborationId: 'collab-1' },
    ] as any);
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
      { userId: 'user-1', projectId: 'project-1' },
      { userId: 'user-2', projectId: 'project-2' },
    ] as any);
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      ownerUserId: 'user-1',
      project: {
        id: 'project-1',
        userId: 'user-1',
        collaborationId: 'collab-1',
        daemonHost: 'daemon-a',
        workspacePath: '/repo-a',
        repoRoot: '/repo-a',
        worktreeBranch: 'main',
        lastCommit: 'abc',
      },
    }) as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'project-2',
      userId: 'user-2',
      collaborationId: 'collab-1',
      daemonHost: 'daemon-b',
      workspacePath: '/repo-b',
      repoRoot: '/repo-b',
      worktreeBranch: 'main',
      lastCommit: 'def',
    } as any);
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      projectId: 'project-2',
      ownerUserId: 'user-1',
      project: {
        id: 'project-2',
        userId: 'user-2',
        collaborationId: 'collab-1',
        daemonHost: 'daemon-b',
        workspacePath: '/repo-b',
        repoRoot: '/repo-b',
        worktreeBranch: 'main',
        lastCommit: 'def',
      },
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { projectId: 'project-2' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: { id: 'project-2' },
      select: expect.objectContaining({
        id: true,
        userId: true,
        collaborationId: true,
      }),
    });
    expect(db.issue.aggregate).toHaveBeenCalledWith({
      where: {
        projectId: 'project-2',
        status: 'todo',
      },
      _max: {
        position: true,
      },
    });
    expect(db.issue.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-2',
        ownerUserId: 'user-1',
        position: 5,
      }),
    }));
  });

  it('rejects owner changes while an issue is doing', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      ownerUserId: 'user-1',
      status: 'doing',
      project: {
        id: 'project-1',
        userId: 'user-1',
        collaborationId: 'collab-1',
        daemonHost: null,
        workspacePath: null,
        repoRoot: null,
        worktreeBranch: null,
        lastCommit: null,
      },
    }) as any);
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
      { userId: 'user-1', projectId: 'project-1' },
      { userId: 'user-2', projectId: 'project-2' },
    ] as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { ownerUserId: 'user-2' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Move the issue out of doing before changing owner');
    expect(db.issue.update).not.toHaveBeenCalled();
  });

  describe('explicit daemon pick via metadata.daemonHost', () => {
    it('honors metadata.daemonHost on a default project so the dialog picker actually controls the spawn', async () => {
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
      // Default project: no daemon binding; resolver falls back to
      // "pick any compatible agent" UNLESS the user explicitly chose one.
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
        { id: 'agent-2', host: 'daemon-b', supportedBackends: ['claude'] },
      ] as any);
      vi.mocked(createAiTaskArtifacts).mockResolvedValue({
        task: {
          id: 'task-pick',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Board implementation',
          status: 'init',
          taskType: 'ai_task',
          agentHost: 'daemon-b',
          executionHost: 'daemon-b',
          backendType: 'claude',
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:20:00.000Z'),
          updatedAt: new Date('2026-04-14T00:20:00.000Z'),
        },
        initialMessage: null,
        initialMessageContent: '...',
      } as any);

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: {
          status: 'doing',
          metadata: { backendType: 'claude', daemonHost: 'daemon-b' },
        },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });

      expect(response.status).toBe(200);
      const createArgs = vi.mocked(createAiTaskArtifacts).mock.calls[0][0] as any;
      // Critical: the spawn lands on daemon-b (the user's pick), not on the
      // resolver's auto-pick which would have been daemon-a (first match).
      expect(createArgs.agentHost).toBe('daemon-b');
    });

    it('rejects metadata.daemonHost that conflicts with a project-bound daemon', async () => {
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
        project: {
          id: 'project-1',
          userId: 'user-1',
          collaborationId: null,
          name: 'BoundApp',
          daemonHost: 'daemon-a',
          workspacePath: '/repo',
          repoRoot: '/repo',
          worktreeBranch: 'main',
          lastCommit: 'aaa',
          gitRemoteUrl: null,
          mergeOptOut: false,
        },
      }) as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
        { id: 'agent-2', host: 'daemon-b', supportedBackends: ['claude'] },
      ] as any);

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: {
          status: 'doing',
          // The project is bound to daemon-a, but the client is asking for
          // daemon-b without switching projectId. Refuse — it would mean
          // running the task on a daemon that does not match the project
          // binding.
          metadata: { backendType: 'claude', daemonHost: 'daemon-b' },
        },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toMatch(/does not match/i);
      expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    });

    it('rejects metadata.daemonHost when the requested daemon is offline', async () => {
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue() as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
      ] as any);

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: {
          status: 'doing',
          metadata: { backendType: 'claude', daemonHost: 'daemon-ghost' },
        },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toMatch(/offline/i);
      expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    });
  });

  describe('merged-group sibling re-parent on todo→doing', () => {
    const buildMergedExistingIssue = (overrides: Record<string, unknown> = {}) =>
      buildExistingIssue({
        project: {
          id: 'project-1',
          userId: 'user-1',
          collaborationId: null,
          name: 'MergedApp',
          daemonHost: 'daemon-a',
          workspacePath: '/repo/a',
          repoRoot: '/repo/a',
          worktreeBranch: 'main',
          lastCommit: 'aaa111',
          gitRemoteUrl: 'github.com/foo/merged-app',
          mergeOptOut: false,
        },
        ...overrides,
      });

    const mockSiblingProject = (overrides: Record<string, unknown> = {}) => {
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: 'project-2',
        userId: 'user-1',
        collaborationId: null,
        name: 'MergedApp',
        daemonHost: 'daemon-b',
        workspacePath: '/repo/b',
        repoRoot: '/repo/b',
        worktreeBranch: 'main',
        lastCommit: 'bbb222',
        gitRemoteUrl: 'github.com/foo/merged-app',
        mergeOptOut: false,
        ...overrides,
      } as any);
    };

    it('re-parents the issue and spawns on the chosen sibling daemon', async () => {
      vi.mocked(db.project.findMany).mockResolvedValue([
        { id: 'project-1', collaborationId: null },
        { id: 'project-2', collaborationId: null },
      ] as any);
      // Default project is project-1 so the sibling (project-2) is NOT default
      // — it must have a daemon binding to pass the binding-incomplete guard.
      vi.mocked(db.defaultProject.findUnique).mockResolvedValue({ projectId: 'project-1' } as any);
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildMergedExistingIssue() as any);
      mockSiblingProject();
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
        { id: 'agent-2', host: 'daemon-b', supportedBackends: ['claude'] },
      ] as any);
      vi.mocked(createAiTaskArtifacts).mockResolvedValue({
        task: {
          id: 'task-sibling',
          projectId: 'project-2',
          issueId: 'issue-1',
          title: 'Board implementation',
          status: 'init',
          taskType: 'ai_task',
          agentHost: 'daemon-b',
          executionHost: 'daemon-b',
          backendType: 'claude',
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: JSON.stringify({ backendType: 'claude' }),
          createdAt: new Date('2026-04-14T00:20:00.000Z'),
          updatedAt: new Date('2026-04-14T00:20:00.000Z'),
        },
        initialMessage: null,
        initialMessageContent: 'Issue: Board implementation\n\nHook issue board into the app shell',
      } as any);
      vi.mocked(db.issue.update).mockImplementation(async ({ data }: any) =>
        buildMergedExistingIssue({
          projectId: data.projectId,
          status: data.status,
          metadata: data.metadata,
        }) as any,
      );

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: {
          projectId: 'project-2',
          status: 'doing',
          metadata: { backendType: 'claude', daemonHost: 'daemon-b' },
        },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });

      expect(response.status).toBe(200);
      // Spawn must land on the sibling project's daemon, not the original.
      const createArgs = vi.mocked(createAiTaskArtifacts).mock.calls[0][0] as any;
      expect(createArgs.projectId).toBe('project-2');
      expect(createArgs.agentHost).toBe('daemon-b');
      expect(createArgs.launchConfig).toEqual(expect.objectContaining({
        projectRepoRoot: '/repo/b',
        projectWorkspacePath: '/repo/b',
      }));
      // The issue row gets re-parented to the sibling project.
      const updateCall = vi.mocked(db.issue.update).mock.calls[0][0] as any;
      expect(updateCall.data.projectId).toBe('project-2');
      // And its persisted metadata.daemonHost matches the daemon we actually
      // resolved — even if the client had hand-rolled the value.
      const persistedMeta = JSON.parse(updateCall.data.metadata as string);
      expect(persistedMeta.daemonHost).toBe('daemon-b');
      expect(persistedMeta.backendType).toBe('claude');
    });

    it('persists metadata.daemonHost as the actually-resolved host when the client honors the project binding', async () => {
      // Sibling re-parent is the only path where metadata.daemonHost can differ
      // from the project's bound daemon; here we exercise the simpler case
      // where the client respects the binding (metadata.daemonHost matches
      // existing.project.daemonHost) and confirm the value the server writes
      // back is sourced from the resolver, not the request payload.
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildMergedExistingIssue() as any);
      vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
        { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
      ] as any);
      vi.mocked(createAiTaskArtifacts).mockResolvedValue({
        task: {
          id: 'task-same',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Board implementation',
          status: 'init',
          taskType: 'ai_task',
          agentHost: 'daemon-a',
          executionHost: 'daemon-a',
          backendType: 'claude',
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: JSON.stringify({ backendType: 'claude' }),
          createdAt: new Date('2026-04-14T00:20:00.000Z'),
          updatedAt: new Date('2026-04-14T00:20:00.000Z'),
        },
        initialMessage: null,
        initialMessageContent: '...',
      } as any);

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: {
          status: 'doing',
          metadata: { backendType: 'claude', daemonHost: 'daemon-a' },
        },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });

      expect(response.status).toBe(200);
      const updateCall = vi.mocked(db.issue.update).mock.calls[0][0] as any;
      const persistedMeta = JSON.parse(updateCall.data.metadata as string);
      expect(persistedMeta.daemonHost).toBe('daemon-a');
    });

    it('rejects a project switch into doing when the target is not a merged-group sibling', async () => {
      vi.mocked(db.project.findMany).mockResolvedValue([
        { id: 'project-1', collaborationId: null },
        { id: 'project-foreign', collaborationId: null },
      ] as any);
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildMergedExistingIssue() as any);
      mockSiblingProject({
        id: 'project-foreign',
        // Different remote URL — explicitly NOT a sibling under the merge rule.
        gitRemoteUrl: 'github.com/other/unrelated',
      });

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: { projectId: 'project-foreign', status: 'doing' },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toMatch(/cross-daemon sibling/i);
      expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    });

    it('rejects a project switch into doing when a linked task still exists on the original daemon', async () => {
      vi.mocked(db.project.findMany).mockResolvedValue([
        { id: 'project-1', collaborationId: null },
        { id: 'project-2', collaborationId: null },
      ] as any);
      vi.mocked(db.issue.findFirst).mockResolvedValue(buildMergedExistingIssue({ status: 'done' }) as any);
      mockIssueTasks({
        activeTasks: [],
        // A still-linked (killed/completed) task implies a worktree on the
        // original daemon — re-parenting would orphan that PTY.
        linkedTasks: [buildTask({ status: 'killed' })],
      });
      mockSiblingProject();

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: { projectId: 'project-2', status: 'doing' },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });
      const data = await extractJson(response);

      expect(response.status).toBe(409);
      expect(data.error).toMatch(/linked task/i);
      expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    });

    it('rejects a project switch into doing when the sibling project belongs to another collaboration member', async () => {
      // Collaboration scenario: both projects share collaborationId so the
      // "same collaboration" guard passes; my new userId guard then catches
      // the cross-member spawn attempt with a 403 before we can land on
      // someone else's daemon. Standalone (no-collab) attempts to switch to
      // another user's project still fail earlier with 400 via the existing
      // collaboration check — covered by the existing test suite.
      vi.mocked(db.project.findMany).mockResolvedValue([
        { id: 'project-1', collaborationId: 'collab-1' },
        { id: 'project-2', collaborationId: 'collab-1' },
      ] as any);
      vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
        { userId: 'user-1', projectId: 'project-1' },
        { userId: 'user-other', projectId: 'project-2' },
      ] as any);
      vi.mocked(db.issue.findFirst).mockResolvedValue(
        buildMergedExistingIssue({
          ownerUserId: 'user-1',
          project: {
            id: 'project-1',
            userId: 'user-1',
            collaborationId: 'collab-1',
            name: 'MergedApp',
            daemonHost: 'daemon-a',
            workspacePath: '/repo/a',
            repoRoot: '/repo/a',
            worktreeBranch: 'main',
            lastCommit: 'aaa111',
            gitRemoteUrl: 'github.com/foo/merged-app',
            mergeOptOut: false,
          },
        }) as any,
      );
      mockSiblingProject({
        userId: 'user-other',
        collaborationId: 'collab-1',
      });

      const response = await PATCH(createMockRequest({
        method: 'PATCH',
        body: { projectId: 'project-2', status: 'doing' },
      }), {
        params: Promise.resolve({ issueId: 'issue-1' }),
      });
      const data = await extractJson(response);

      expect(response.status).toBe(403);
      expect(data.error).toMatch(/current user/i);
      expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    });
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

  it('rejects deleting a running issue', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'doing' }) as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Move the issue out of doing before deleting it');
    expect(db.issue.delete).not.toHaveBeenCalled();
  });

  it('falls back to the legacy select when the AI session columns are missing on the issues table', async () => {
    vi.mocked(db.issue.findFirst)
      .mockRejectedValueOnce(missingAiSessionColumnError())
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
      ai_backend_type: null,
      ai_session_id: null,
    }));
  });

  it('exposes the persisted AI backend type and session id on issue detail so the breadcrumb survives task deletion', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      status: 'done',
      aiBackendType: 'codex',
      aiSessionId: 'sess-archived-1',
    }) as any);
    mockIssueTasks({
      activeTasks: [],
      // Simulate the case where the originating task has been deleted: linked
      // tasks are empty, but the issue should still expose the AI session
      // breadcrumb that was mirrored from the (now-deleted) task.
      linkedTasks: [],
    });

    const response = await GET(createMockRequest({ method: 'GET' }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-1',
      aiBackendType: 'codex',
      aiSessionId: 'sess-archived-1',
      ai_backend_type: 'codex',
      ai_session_id: 'sess-archived-1',
      linked_task: null,
      active_task: null,
    }));
  });

  it('mirrors the source task backend/session onto the issue when restarting in place', async () => {
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['codex'] },
    ] as any);
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'done' }) as any);
    mockIssueTasks({
      activeTasks: [],
      linkedTasks: [buildTask({
        status: 'killed',
        backendType: 'codex',
        sessionId: 'sess-restart-7',
      })],
    });
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({
      status: 'doing',
      aiBackendType: 'codex',
      aiSessionId: 'sess-restart-7',
    }) as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: { status: 'doing' },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    const issueUpdateCalls = vi.mocked(db.issue.update).mock.calls;
    const persistedAiSessionCall = issueUpdateCalls.find(([call]) => {
      const data = (call as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      return data.aiBackendType === 'codex' && data.aiSessionId === 'sess-restart-7';
    });
    expect(persistedAiSessionCall).toBeDefined();
  });

  it('routes /goal issues into goal mode for goal-capable backends', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      description: '/goal ship the feature\n\nsupporting context',
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-goal',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'ship the feature\n\nsupporting context',
      effectiveLaunchConfig: null,
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: { backendType: 'claude' },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    expect(createAiTaskArtifacts).toHaveBeenCalledWith(
      expect.objectContaining({
        aiMode: 'goal',
        goal: expect.objectContaining({
          objective: 'ship the feature\n\nsupporting context',
          source: 'issue',
          issueId: 'issue-1',
        }),
        // Single source of truth: initial message content equals goal.objective
        // (no leading "Issue: <title>" framing — that would diverge from the
        // bare objective the daemon prefills).
        initialMessageContent: 'ship the feature\n\nsupporting context',
        requestedBackendType: 'claude',
      }),
      expect.any(Object),
    );
  });

  it('goal mode: metadata.initialContent === launch_config.goal.objective === Message.content (single source of truth)', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      description: '/goal ship the feature\n\nsupporting context',
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-goal-canonical',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: 'claude',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: { id: 'msg-1', createdAt: new Date('2026-04-14T00:20:00.000Z') },
      initialMessageContent: 'ship the feature\n\nsupporting context',
      effectiveLaunchConfig: {
        cwd: '/repo',
        aiMode: 'goal',
        goal: {
          objective: 'ship the feature\n\nsupporting context',
          source: 'issue',
          issueId: 'issue-1',
        },
      },
    } as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: { backendType: 'claude' },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });
    expect(response.status).toBe(200);

    const spawnCall = vi.mocked(createAiTaskArtifacts).mock.calls.at(-1)?.[0];
    expect(spawnCall).toBeDefined();
    const canonical = 'ship the feature\n\nsupporting context';

    // 1) metadata.initialContent (the JSON field on the issue metadata)
    const metadata = spawnCall?.metadata as Record<string, unknown> | undefined;
    expect(metadata?.initialContent).toBe(canonical);

    // 2) launch_config.goal.objective (delivered to the daemon)
    expect(spawnCall?.goal?.objective).toBe(canonical);

    // 3) Initial Message content (persisted, broadcast to client)
    expect(spawnCall?.initialMessageContent).toBe(canonical);
  });

  it('PATCH updating body to /goal without doing transition does not spawn a task or set aiMode', async () => {
    // Reviewer gap #5: a plain body edit that introduces `/goal ...` must NOT
    // dispatch a goal task or stamp goal metadata. Only the todo→doing
    // transition is allowed to trigger goal-mode dispatch.
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      status: 'todo',
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['claude'] },
    ] as any);

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        // body update only — no `status: 'doing'`
        description: '/goal ship the feature',
        metadata: { backendType: 'claude' },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    // No spawn => no goal-mode dispatch.
    expect(createAiTaskArtifacts).not.toHaveBeenCalled();
    expect(finalizeAiTaskCreation).not.toHaveBeenCalled();

    // The persisted issue.metadata must not carry aiMode anywhere — only
    // doing-transition spawns are allowed to stamp it.
    const issueUpdateCalls = vi.mocked(db.issue.update).mock.calls;
    for (const [callArgs] of issueUpdateCalls) {
      const data = (callArgs as { data?: Record<string, unknown> } | undefined)?.data ?? {};
      const metadataJson = data.metadata;
      if (typeof metadataJson === 'string') {
        const parsed = JSON.parse(metadataJson);
        expect(parsed).not.toHaveProperty('aiMode');
        expect(parsed?.goal).toBeUndefined();
      }
    }
  });

  it('ignores /goal directive when the selected backend is not goal-capable', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      description: '/goal kimi cannot do this',
    }) as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([
      { id: 'agent-1', host: 'daemon-a', supportedBackends: ['kimi'] },
    ] as any);
    vi.mocked(createAiTaskArtifacts).mockResolvedValue({
      task: {
        id: 'task-kimi',
        projectId: 'project-1',
        issueId: 'issue-1',
        title: 'Board implementation',
        status: 'init',
        taskType: 'ai_task',
        agentHost: 'daemon-a',
        executionHost: 'daemon-a',
        backendType: 'kimi',
        sessionId: null,
        sessionFilePath: null,
        launchConfig: null,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      },
      initialMessage: null,
      initialMessageContent: 'Issue: Board implementation\n\n/goal kimi cannot do this',
      effectiveLaunchConfig: null,
    } as any);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await PATCH(createMockRequest({
      method: 'PATCH',
      body: {
        status: 'doing',
        metadata: { backendType: 'kimi' },
      },
    }), {
      params: Promise.resolve({ issueId: 'issue-1' }),
    });

    expect(response.status).toBe(200);
    const spawnCall = vi.mocked(createAiTaskArtifacts).mock.calls.at(-1)?.[0];
    expect(spawnCall).toBeDefined();
    expect(spawnCall).not.toHaveProperty('aiMode');
    expect(spawnCall).not.toHaveProperty('goal');
    // Normal flow keeps the full issue description (including the literal
    // `/goal` line) in the initial content — the directive is treated as
    // ordinary prose.
    expect(spawnCall?.initialMessageContent).toContain('/goal kimi cannot do this');
    warnSpy.mockRestore();
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

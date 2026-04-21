import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, PATCH } from './route';
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
      findFirst: vi.fn(),
      update: vi.fn(),
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

vi.mock('@/lib/tasks/task-stop', () => ({
  stopTaskBeforeRelaunch: vi.fn(),
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    getAgentsForUser: vi.fn(),
    getTaskAgentHost: vi.fn(),
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');
const { createAiTaskArtifacts, finalizeAiTaskCreation } = await import('@/lib/tasks/create-ai-task');
const { stopTaskBeforeRelaunch } = await import('@/lib/tasks/task-stop');
const { realtimeHub } = await import('@/lib/realtime/hub');

const buildExistingIssue = (overrides: Record<string, unknown> = {}) => ({
  id: 'issue-1',
  projectId: 'project-1',
  title: 'Board implementation',
  description: 'Hook issue board into the app shell',
  status: 'todo',
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

describe('/api/issues/[issueId]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-1' } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      typeof callback === 'function'
        ? callback({ issue: db.issue, task: db.task })
        : callback,
    );
    vi.mocked(db.defaultProject.findUnique).mockResolvedValue({ projectId: 'project-1' } as any);
    vi.mocked(realtimeHub.getAgentsForUser).mockReturnValue([]);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: 4 } } as any);
    vi.mocked(db.issue.update).mockResolvedValue(buildExistingIssue({ status: 'doing', tasks: [] }) as any);
    vi.mocked(db.issue.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(db.task.findFirst).mockResolvedValue({
      id: 'task-active',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Existing active task',
      status: 'killed',
      taskType: 'ai_task',
      agentHost: null,
      executionHost: null,
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: null,
      metadata: null,
      createdAt: new Date('2026-04-14T00:15:00.000Z'),
      updatedAt: new Date('2026-04-14T00:25:00.000Z'),
    } as any);
    vi.mocked(db.task.update).mockResolvedValue({
      id: 'task-active',
      projectId: 'project-1',
      issueId: 'issue-1',
      title: 'Existing active task',
      status: 'killed',
      taskType: 'ai_task',
      agentHost: null,
      executionHost: null,
      backendType: null,
      sessionId: null,
      sessionFilePath: null,
      launchConfig: null,
      metadata: null,
      createdAt: new Date('2026-04-14T00:15:00.000Z'),
      updatedAt: new Date('2026-04-14T00:25:00.000Z'),
    } as any);
    vi.mocked(db.issue.delete).mockResolvedValue({ id: 'issue-1' } as any);
    vi.mocked(finalizeAiTaskCreation).mockResolvedValue(undefined);
    vi.mocked(stopTaskBeforeRelaunch).mockResolvedValue({ ok: true });
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue(null);
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

  it('does not spawn when entering doing from a non-todo status', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({ status: 'done' }) as any);

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
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      tasks: [
        {
          id: 'task-active',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Existing active task',
          status: 'running',
          taskType: 'ai_task',
          agentHost: null,
          executionHost: null,
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:15:00.000Z'),
          updatedAt: new Date('2026-04-14T00:15:00.000Z'),
        },
      ],
    }) as any);

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

  it('does not spawn a duplicate task when an active linked task already exists', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      tasks: [
        {
          id: 'task-active',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Existing active task',
          status: 'running',
          taskType: 'ai_task',
          agentHost: null,
          executionHost: null,
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:15:00.000Z'),
          updatedAt: new Date('2026-04-14T00:15:00.000Z'),
        },
      ],
    }) as any);

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
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      status: 'doing',
      tasks: [
        {
          id: 'task-active',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Existing active task',
          status: 'running',
          taskType: 'ai_task',
          agentHost: null,
          executionHost: 'daemon-a',
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:15:00.000Z'),
          updatedAt: new Date('2026-04-14T00:15:00.000Z'),
        },
      ],
    }) as any);
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
    }));
    expect(data.activeTask).toBeNull();
    expect(data.killedTask).toEqual(expect.objectContaining({
      id: 'task-active',
      status: 'killed',
      execution_host: null,
    }));
  });

  it('also stops an init linked task before moving a doing issue to done', async () => {
    vi.mocked(realtimeHub.getTaskAgentHost).mockReturnValue('daemon-a');
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      status: 'doing',
      tasks: [
        {
          id: 'task-init',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Existing init task',
          status: 'init',
          taskType: 'ai_task',
          agentHost: 'daemon-a',
          executionHost: 'daemon-a',
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:15:00.000Z'),
          updatedAt: new Date('2026-04-14T00:15:00.000Z'),
        },
      ],
    }) as any);
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

  it('returns 409 when a doing issue task is still active but has no daemon binding', async () => {
    vi.mocked(db.issue.findFirst).mockResolvedValue(buildExistingIssue({
      status: 'doing',
      tasks: [
        {
          id: 'task-active',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Existing active task',
          status: 'running',
          taskType: 'ai_task',
          agentHost: null,
          executionHost: null,
          backendType: null,
          sessionId: null,
          sessionFilePath: null,
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:15:00.000Z'),
          updatedAt: new Date('2026-04-14T00:15:00.000Z'),
        },
      ],
    }) as any);
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

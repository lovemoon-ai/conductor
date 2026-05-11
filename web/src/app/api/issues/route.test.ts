import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from './route';
import { createMockRequest, extractJson } from '@/__tests__/helpers';

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    issue: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    task: {
      findMany: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    collaborationMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('@/lib/realtime/hub', () => ({
  realtimeHub: {
    broadcast: vi.fn(),
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');
const { realtimeHub } = await import('@/lib/realtime/hub');

const missingPriorityColumnError = () =>
  new Prisma.PrismaClientKnownRequestError(
    'The column `issues.priority` does not exist in the current database.',
    {
      code: 'P2022',
      clientVersion: 'test',
    },
  );

describe('/api/issues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: 'user-1',
    } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
    vi.mocked(db.project.findMany).mockResolvedValue([
      { id: 'project-1', collaborationId: null },
      { id: 'project-2', collaborationId: null },
    ] as any);
    vi.mocked(db.project.findUnique).mockImplementation(async ({ where }: any) => ({
      id: where.id,
      userId: 'user-1',
      collaborationId: null,
    }) as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'project-1',
      userId: 'user-1',
      collaborationId: null,
    } as any);
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([] as any);
    vi.mocked(db.collaborationMember.findUnique).mockResolvedValue(null as any);
  });

  it('lists issues scoped to the requested project', async () => {
    vi.mocked(db.issue.findMany).mockResolvedValue([
      {
        id: 'issue-1',
        projectId: 'project-1',
        title: 'Issue board',
        description: 'Build the board UI',
        status: 'todo',
        priority: 'P0',
        position: 2,
        metadata: null,
        tasks: [],
        createdAt: new Date('2026-04-14T00:00:00.000Z'),
        updatedAt: new Date('2026-04-14T00:10:00.000Z'),
      },
    ] as any);

    const response = await GET(createMockRequest({
      method: 'GET',
      url: 'http://localhost:6152/api/issues?project_id=project-1',
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.issue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        projectId: { in: ['project-1'] },
      }),
    }));
    expect(data).toEqual([
      expect.objectContaining({
        id: 'issue-1',
        projectId: 'project-1',
        project_id: 'project-1',
        title: 'Issue board',
        status: 'todo',
        priority: 'P0',
        position: 2,
        linked_task: null,
      }),
    ]);
  });

  it('falls back to default priority when the priority column is missing in list queries', async () => {
    vi.mocked(db.issue.findMany)
      .mockRejectedValueOnce(missingPriorityColumnError())
      .mockResolvedValueOnce([
        {
          id: 'issue-legacy',
          projectId: 'project-1',
          title: 'Legacy issue',
          description: null,
          status: 'todo',
          position: 0,
          metadata: null,
          createdAt: new Date('2026-04-14T00:00:00.000Z'),
          updatedAt: new Date('2026-04-14T00:10:00.000Z'),
        },
      ] as any);

    const response = await GET(createMockRequest({
      method: 'GET',
      url: 'http://localhost:6152/api/issues?project_id=project-1',
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(vi.mocked(db.issue.findMany)).toHaveBeenCalledTimes(2);
    expect(data).toEqual([
      expect.objectContaining({
        id: 'issue-legacy',
        priority: 'P1',
      }),
    ]);
  });

  it('keeps the latest linked task in list responses even after it stops', async () => {
    vi.mocked(db.issue.findMany).mockResolvedValue([
      {
        id: 'issue-1',
        projectId: 'project-1',
        title: 'Persist linked task',
        description: null,
        status: 'done',
        position: 0,
        metadata: null,
        createdAt: new Date('2026-04-14T00:00:00.000Z'),
        updatedAt: new Date('2026-04-14T00:10:00.000Z'),
      },
    ] as any);
    vi.mocked(db.task.findMany)
      .mockResolvedValueOnce([] as any)
      .mockResolvedValueOnce([
        {
          id: 'task-killed',
          projectId: 'project-1',
          issueId: 'issue-1',
          title: 'Persist linked task',
          status: 'killed',
          taskType: 'ai_task',
          agentHost: 'daemon-a',
          executionHost: null,
          backendType: 'codex',
          sessionId: 'sess-1',
          sessionFilePath: '/tmp/sess-1.jsonl',
          launchConfig: null,
          metadata: null,
          createdAt: new Date('2026-04-14T00:05:00.000Z'),
          updatedAt: new Date('2026-04-14T00:10:00.000Z'),
        },
      ] as any);

    const response = await GET(createMockRequest({
      method: 'GET',
      url: 'http://localhost:6152/api/issues?project_id=project-1',
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data).toEqual([
      expect.objectContaining({
        id: 'issue-1',
        active_task: null,
        linked_task: expect.objectContaining({
          id: 'task-killed',
          status: 'killed',
          issue_id: 'issue-1',
        }),
      }),
    ]);
  });

  it('lists issues from all members of a merged group via project_ids and includes daemon attribution', async () => {
    vi.mocked(db.issue.findMany).mockResolvedValue([
      {
        id: 'issue-a',
        projectId: 'project-a',
        title: 'On daemon-a',
        description: null,
        status: 'todo',
        priority: 'P1',
        position: 0,
        metadata: null,
        tasks: [],
        createdAt: new Date('2026-04-14T00:00:00.000Z'),
        updatedAt: new Date('2026-04-14T00:10:00.000Z'),
        project: { name: 'My Project', daemonHost: 'daemon-a' },
      },
      {
        id: 'issue-b',
        projectId: 'project-b',
        title: 'On daemon-b',
        description: null,
        status: 'todo',
        priority: 'P1',
        position: 1,
        metadata: null,
        tasks: [],
        createdAt: new Date('2026-04-14T00:01:00.000Z'),
        updatedAt: new Date('2026-04-14T00:11:00.000Z'),
        project: { name: 'My Project', daemonHost: 'daemon-b' },
      },
    ] as any);

    const response = await GET(createMockRequest({
      method: 'GET',
      url: 'http://localhost:6152/api/issues?project_ids=project-a,project-b',
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.issue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        project: { userId: 'user-1' },
        projectId: { in: ['project-a', 'project-b'] },
      }),
    }));
    expect(data).toEqual([
      expect.objectContaining({
        id: 'issue-a',
        daemonHost: 'daemon-a',
        daemon_host: 'daemon-a',
        projectName: 'My Project',
        project_name: 'My Project',
      }),
      expect.objectContaining({
        id: 'issue-b',
        daemonHost: 'daemon-b',
        daemon_host: 'daemon-b',
      }),
    ]);
  });

  it('rejects requests that combine project_id and project_ids', async () => {
    const response = await GET(createMockRequest({
      method: 'GET',
      url: 'http://localhost:6152/api/issues?project_id=project-a&project_ids=project-b',
    }));
    expect(response.status).toBe(400);
  });

  it('lists issues from all user projects when project_id is missing', async () => {
    vi.mocked(db.issue.findMany).mockResolvedValue([
      {
        id: 'issue-1',
        projectId: 'project-1',
        title: 'Project one issue',
        description: null,
        status: 'todo',
        position: 0,
        metadata: null,
        tasks: [],
        createdAt: new Date('2026-04-14T00:00:00.000Z'),
        updatedAt: new Date('2026-04-14T00:10:00.000Z'),
      },
      {
        id: 'issue-2',
        projectId: 'project-2',
        title: 'Project two issue',
        description: null,
        status: 'doing',
        position: 1,
        metadata: null,
        tasks: [],
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:30:00.000Z'),
      },
    ] as any);

    const response = await GET(createMockRequest({
      method: 'GET',
      url: 'http://localhost:6152/api/issues',
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.issue.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        projectId: { in: ['project-1', 'project-2'] },
      },
    }));
    expect(data).toEqual([
      expect.objectContaining({
        id: 'issue-1',
        projectId: 'project-1',
        project_id: 'project-1',
      }),
      expect.objectContaining({
        id: 'issue-2',
        projectId: 'project-2',
        project_id: 'project-2',
      }),
    ]);
  });

  it('creates an issue using the next position when none is provided', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: 4 } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-2',
      projectId: 'project-1',
      title: 'Ship issue nav',
      description: null,
      status: 'todo',
      priority: 'P1',
      position: 5,
      metadata: null,
      tasks: [],
      createdAt: new Date('2026-04-14T00:20:00.000Z'),
      updatedAt: new Date('2026-04-14T00:20:00.000Z'),
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Ship issue nav',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.issue.aggregate).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        projectId: 'project-1',
        status: 'todo',
      }),
    }));
    expect(db.issue.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId: 'project-1',
        title: 'Ship issue nav',
        status: 'todo',
        priority: 'P1',
        position: 5,
      }),
    }));
    expect((vi.mocked(db.issue.create).mock.calls[0]?.[0] as any).select.project).toBeUndefined();
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-2',
      projectId: 'project-1',
      project_id: 'project-1',
      priority: 'P1',
      position: 5,
    }));
  });

  it('creates an issue with daemon attribution when requested by a merged view', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-merged',
      projectId: 'project-1',
      title: 'Merged create',
      description: null,
      status: 'todo',
      priority: 'P1',
      position: 0,
      metadata: null,
      tasks: [],
      createdAt: new Date('2026-04-14T00:20:00.000Z'),
      updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      project: { name: 'Alpha', daemonHost: 'daemon-a' },
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        project_id: 'project-1',
        title: 'Merged create',
        include_project: true,
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect((vi.mocked(db.issue.create).mock.calls[0]?.[0] as any).select.project).toEqual({
      select: {
        name: true,
        daemonHost: true,
      },
    });
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-merged',
      daemonHost: 'daemon-a',
      daemon_host: 'daemon-a',
      projectName: 'Alpha',
      project_name: 'Alpha',
    }));
  });

  it('maps legacy backlog create requests to todo', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-legacy',
      projectId: 'project-1',
      title: 'Legacy client issue',
      description: null,
      status: 'todo',
      position: 0,
      metadata: null,
      tasks: [],
      createdAt: new Date('2026-04-14T00:20:00.000Z'),
      updatedAt: new Date('2026-04-14T00:20:00.000Z'),
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Legacy client issue',
        status: 'backlog',
      },
    }));

    expect(response.status).toBe(200);
    expect(db.issue.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'todo',
        position: 0,
      }),
    }));
  });

  it('creates issues with default priority when the priority column is missing', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create)
      .mockRejectedValueOnce(missingPriorityColumnError())
      .mockResolvedValueOnce({
        id: 'issue-compat',
        projectId: 'project-1',
        title: 'Compat issue',
        description: null,
        status: 'todo',
        position: 0,
        metadata: null,
        createdAt: new Date('2026-04-14T00:20:00.000Z'),
        updatedAt: new Date('2026-04-14T00:20:00.000Z'),
      } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Compat issue',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(vi.mocked(db.issue.create)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.issue.create).mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        priority: 'P1',
      }),
    }));
    expect((vi.mocked(db.issue.create).mock.calls[1]?.[0] as { data: Record<string, unknown> }).data).not.toHaveProperty('priority');
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-compat',
      priority: 'P1',
    }));
  });

  it('returns a migration error when creating a non-default priority issue without the priority column', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create).mockRejectedValueOnce(missingPriorityColumnError());

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Blocked issue',
        priority: 'P0',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toContain("Issue priority is unavailable");
    expect(vi.mocked(db.issue.create)).toHaveBeenCalledTimes(1);
  });

  it('broadcasts issue.created on a fresh create and persists clientRequestId in metadata', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    // Idempotency lookup runs first when clientRequestId is provided.
    vi.mocked(db.issue.findMany).mockResolvedValueOnce([] as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-cri',
      projectId: 'project-1',
      title: 'Idempotent create',
      description: null,
      status: 'todo',
      priority: 'P1',
      position: 0,
      metadata: JSON.stringify({
        audit: { actor: 'cli', cliVersion: '1.2.3' },
        clientRequestId: 'req-abc',
      }),
      createdAt: new Date('2026-04-14T00:20:00.000Z'),
      updatedAt: new Date('2026-04-14T00:20:00.000Z'),
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Idempotent create',
        clientRequestId: 'req-abc',
        metadata: { audit: { actor: 'cli', cliVersion: '1.2.3' } },
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe('issue-cri');
    // metadata round-trips: audit namespace preserved, clientRequestId merged in.
    expect(data.metadata).toEqual({
      audit: { actor: 'cli', cliVersion: '1.2.3' },
      clientRequestId: 'req-abc',
    });
    // The persisted JSON includes the merged clientRequestId.
    const createCall = vi.mocked(db.issue.create).mock.calls[0]?.[0] as { data: { metadata: string } };
    expect(JSON.parse(createCall.data.metadata)).toEqual({
      audit: { actor: 'cli', cliVersion: '1.2.3' },
      clientRequestId: 'req-abc',
    });
    // Broadcast fires exactly once on the create path.
    expect(realtimeHub.broadcast).toHaveBeenCalledTimes(1);
    expect(realtimeHub.broadcast).toHaveBeenCalledWith(
      'user-1',
      'project-1',
      expect.objectContaining({
        type: 'issue.created',
        payload: expect.objectContaining({
          projectId: 'project-1',
          issue: expect.objectContaining({ id: 'issue-cri' }),
        }),
      }),
    );
  });

  it('returns the existing issue without broadcasting when clientRequestId already exists', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.findMany).mockResolvedValueOnce([
      {
        id: 'issue-existing',
        projectId: 'project-1',
        title: 'Already there',
        description: null,
        status: 'todo',
        priority: 'P1',
        position: 0,
        metadata: JSON.stringify({ clientRequestId: 'req-xyz', audit: { actor: 'cli' } }),
        createdAt: new Date('2026-04-14T00:00:00.000Z'),
        updatedAt: new Date('2026-04-14T00:10:00.000Z'),
      },
    ] as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Should be ignored',
        clientRequestId: 'req-xyz',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.id).toBe('issue-existing');
    expect(data.title).toBe('Already there');
    expect(db.issue.create).not.toHaveBeenCalled();
    expect(realtimeHub.broadcast).not.toHaveBeenCalled();
  });

  it('passes through audit metadata under metadata.audit on create round-trip', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-audit',
      projectId: 'project-1',
      title: 'Audit',
      description: null,
      status: 'todo',
      priority: 'P1',
      position: 0,
      metadata: JSON.stringify({ audit: { actor: 'cli', cliVersion: '9.9.9', invokedBy: 'claude-code' } }),
      createdAt: new Date('2026-04-14T00:20:00.000Z'),
      updatedAt: new Date('2026-04-14T00:20:00.000Z'),
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Audit',
        metadata: { audit: { actor: 'cli', cliVersion: '9.9.9', invokedBy: 'claude-code' } },
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.metadata).toEqual({
      audit: { actor: 'cli', cliVersion: '9.9.9', invokedBy: 'claude-code' },
    });
    const createCall = vi.mocked(db.issue.create).mock.calls[0]?.[0] as { data: { metadata: string } };
    expect(JSON.parse(createCall.data.metadata)).toEqual({
      audit: { actor: 'cli', cliVersion: '9.9.9', invokedBy: 'claude-code' },
    });
  });

  it('strips top-level audit-shaped keys (actor / cliVersion / invokedBy / sdkVersion)', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1', userId: 'user-1', collaborationId: null } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: null } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-strip',
      projectId: 'project-1',
      title: 'Strip',
      description: null,
      status: 'todo',
      priority: 'P1',
      position: 0,
      // Persisted shape: only the audit namespace and `extra` survive; the
      // top-level spoof keys were dropped server-side.
      metadata: JSON.stringify({ audit: { actor: 'cli' }, extra: 'kept' }),
      createdAt: new Date('2026-04-14T00:20:00.000Z'),
      updatedAt: new Date('2026-04-14T00:20:00.000Z'),
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        projectId: 'project-1',
        title: 'Strip',
        metadata: {
          audit: { actor: 'cli' },
          // Caller tries to spoof at the top level. Server must drop these.
          actor: 'system',
          cliVersion: 'fake',
          sdkVersion: 'fake',
          invokedBy: 'attacker',
          extra: 'kept',
        },
      },
    }));

    expect(response.status).toBe(200);
    const createCall = vi.mocked(db.issue.create).mock.calls[0]?.[0] as { data: { metadata: string } };
    const persisted = JSON.parse(createCall.data.metadata);
    expect(persisted).toEqual({
      audit: { actor: 'cli' },
      extra: 'kept',
    });
    expect(persisted.actor).toBeUndefined();
    expect(persisted.cliVersion).toBeUndefined();
    expect(persisted.sdkVersion).toBeUndefined();
    expect(persisted.invokedBy).toBeUndefined();
  });
});

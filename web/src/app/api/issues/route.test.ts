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
      findFirst: vi.fn(),
    },
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');

describe('/api/issues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: 'user-1',
    } as any);
    vi.mocked(db.task.findMany).mockResolvedValue([] as any);
  });

  it('lists issues scoped to the requested project', async () => {
    vi.mocked(db.issue.findMany).mockResolvedValue([
      {
        id: 'issue-1',
        projectId: 'project-1',
        title: 'Issue board',
        description: 'Build the board UI',
        status: 'todo',
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
        project: { userId: 'user-1' },
        projectId: 'project-1',
      }),
    }));
    expect(data).toEqual([
      expect.objectContaining({
        id: 'issue-1',
        projectId: 'project-1',
        project_id: 'project-1',
        title: 'Issue board',
        status: 'todo',
        position: 2,
        linked_task: null,
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
        project: { userId: 'user-1' },
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
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1' } as any);
    vi.mocked(db.issue.aggregate).mockResolvedValue({ _max: { position: 4 } } as any);
    vi.mocked(db.issue.create).mockResolvedValue({
      id: 'issue-2',
      projectId: 'project-1',
      title: 'Ship issue nav',
      description: null,
      status: 'todo',
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
        position: 5,
      }),
    }));
    expect(data).toEqual(expect.objectContaining({
      id: 'issue-2',
      projectId: 'project-1',
      project_id: 'project-1',
      position: 5,
    }));
  });

  it('maps legacy backlog create requests to todo', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({ id: 'project-1' } as any);
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
});

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
        status: 'todo',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
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
});

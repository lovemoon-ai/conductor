import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE } from './route';
import { createMockRequest } from '@/__tests__/helpers';

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: vi.fn(),
    collaborationMember: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    project: {
      update: vi.fn(),
    },
    projectCollaboration: {
      delete: vi.fn(),
    },
    issue: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');

describe('/api/collaboration/[collaborationId]/members/me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-1' } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      callback({
        collaborationMember: db.collaborationMember,
        project: db.project,
        projectCollaboration: db.projectCollaboration,
        issue: db.issue,
      }),
    );
    vi.mocked(db.collaborationMember.findUnique).mockResolvedValue({
      id: 'member-1',
      projectId: 'project-1',
    } as any);
    vi.mocked(db.collaborationMember.delete).mockResolvedValue({ id: 'member-1' } as any);
    vi.mocked(db.project.update).mockResolvedValue({ id: 'project-1' } as any);
    vi.mocked(db.issue.findFirst).mockResolvedValue(null as any);
    vi.mocked(db.issue.updateMany).mockResolvedValue({ count: 2 } as any);
  });

  it('reassigns remaining collaboration issues owned by the leaving user', async () => {
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
      { userId: 'user-2', projectId: 'project-2' },
      { userId: 'user-3', projectId: 'project-3' },
    ] as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ collaborationId: 'collab-1' }),
    });

    expect(response.status).toBe(204);
    expect(db.collaborationMember.findMany).toHaveBeenCalledWith({
      where: {
        collaborationId: 'collab-1',
        id: { not: 'member-1' },
      },
      orderBy: { joinedAt: 'asc' },
      select: {
        userId: true,
        projectId: true,
      },
    });
    expect(db.issue.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        ownerUserId: 'user-1',
        projectId: { in: ['project-2', 'project-3'] },
        status: { in: ['doing', 'review'] },
      },
      select: { id: true },
    });
    expect(db.issue.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        projectId: 'project-1',
        ownerUserId: { not: 'user-1' },
        status: { in: ['doing', 'review'] },
      },
      select: { id: true },
    });
    expect(db.issue.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        ownerUserId: 'user-1',
        projectId: { in: ['project-2', 'project-3'] },
      },
      data: {
        ownerUserId: 'user-2',
      },
    });
    expect(db.issue.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        projectId: 'project-1',
        ownerUserId: { not: 'user-1' },
      },
      data: {
        ownerUserId: 'user-1',
      },
    });
    expect(db.projectCollaboration.delete).not.toHaveBeenCalled();
  });

  it('blocks leaving when the user owns running issues in remaining projects', async () => {
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
      { userId: 'user-2', projectId: 'project-2' },
    ] as any);
    vi.mocked(db.issue.findFirst).mockResolvedValueOnce({ id: 'issue-running' } as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ collaborationId: 'collab-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe('Move owned running issues out of doing before leaving collaboration');
    expect(db.collaborationMember.delete).not.toHaveBeenCalled();
    expect(db.project.update).not.toHaveBeenCalled();
    expect(db.issue.updateMany).not.toHaveBeenCalled();
  });

  it('blocks leaving when collaborators own running issues in the leaving project', async () => {
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([
      { userId: 'user-2', projectId: 'project-2' },
    ] as any);
    vi.mocked(db.issue.findFirst)
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce({ id: 'issue-running-local' } as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ collaborationId: 'collab-1' }),
    });
    const data = await response.json();

    expect(response.status).toBe(409);
    expect(data.error).toBe('Ask collaborators to move running issues out of doing before leaving collaboration');
    expect(db.collaborationMember.delete).not.toHaveBeenCalled();
    expect(db.project.update).not.toHaveBeenCalled();
    expect(db.issue.updateMany).not.toHaveBeenCalled();
  });

  it('deletes the collaboration when the last member leaves', async () => {
    vi.mocked(db.collaborationMember.findMany).mockResolvedValue([] as any);

    const response = await DELETE(createMockRequest({ method: 'DELETE' }), {
      params: Promise.resolve({ collaborationId: 'collab-1' }),
    });

    expect(response.status).toBe(204);
    expect(db.issue.updateMany).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        ownerUserId: { not: 'user-1' },
      },
      data: {
        ownerUserId: 'user-1',
      },
    });
    expect(db.projectCollaboration.delete).toHaveBeenCalledWith({
      where: { id: 'collab-1' },
    });
  });
});

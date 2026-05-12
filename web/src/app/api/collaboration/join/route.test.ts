import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { createMockRequest, extractJson } from '@/__tests__/helpers';

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: vi.fn(),
    projectCollaboration: {
      findUnique: vi.fn(),
    },
    project: {
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    collaborationMember: {
      create: vi.fn(),
      count: vi.fn(),
    },
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');

const buildMember = (overrides: Record<string, unknown> = {}) => ({
  id: 'member-1',
  userId: 'user-1',
  projectId: 'project-1',
  joinedAt: new Date('2026-05-03T00:00:00.000Z'),
  user: {
    id: 'user-1',
    email: 'user1@example.com',
    phone: null,
  },
  project: {
    id: 'project-1',
    name: 'Project One',
  },
  ...overrides,
});

describe('/api/collaboration/join', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-2' } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      callback({
        projectCollaboration: db.projectCollaboration,
        project: db.project,
        collaborationMember: db.collaborationMember,
      }),
    );
    vi.mocked(db.project.aggregate).mockResolvedValue({ _max: { sortOrder: 1 } } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'project-2',
      collaborationId: null,
      defaultProject: null,
    } as any);
    vi.mocked(db.project.create).mockResolvedValue({ id: 'project-created' } as any);
    vi.mocked(db.project.update).mockResolvedValue({ id: 'project-2' } as any);
    vi.mocked(db.collaborationMember.create).mockResolvedValue({ id: 'member-2' } as any);
    vi.mocked(db.collaborationMember.count).mockResolvedValue(2);
  });

  it('joins an invited collaboration with the current user project', async () => {
    vi.mocked(db.projectCollaboration.findUnique)
      .mockResolvedValueOnce({
        id: 'collab-1',
        members: [buildMember()],
      } as any)
      .mockResolvedValueOnce({
        id: 'collab-1',
        inviteToken: 'invite-token',
        createdAt: new Date('2026-05-03T00:00:00.000Z'),
        members: [
          buildMember(),
          buildMember({
            id: 'member-2',
            userId: 'user-2',
            projectId: 'project-2',
            user: { id: 'user-2', email: 'user2@example.com', phone: null },
            project: { id: 'project-2', name: 'Project Two' },
          }),
        ],
      } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        projectId: 'project-2',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.collaborationMember.create).toHaveBeenCalledWith({
      data: {
        collaborationId: 'collab-1',
        userId: 'user-2',
        projectId: 'project-2',
      },
    });
    expect(db.project.update).toHaveBeenCalledWith({
      where: { id: 'project-2' },
      data: { collaborationId: 'collab-1' },
    });
    expect(db.collaborationMember.count).toHaveBeenCalledWith({
      where: { collaborationId: 'collab-1' },
    });
    expect(data.collaboration.memberCount).toBe(2);
    expect(data.projectId).toBe('project-2');
  });

  it('creates an unbound project and joins the invited collaboration', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValueOnce(null);
    vi.mocked(db.project.create).mockResolvedValueOnce({ id: 'project-created' } as any);
    vi.mocked(db.projectCollaboration.findUnique)
      .mockResolvedValueOnce({
        id: 'collab-1',
        members: [buildMember()],
      } as any)
      .mockResolvedValueOnce({
        id: 'collab-1',
        inviteToken: 'invite-token',
        createdAt: new Date('2026-05-03T00:00:00.000Z'),
        members: [
          buildMember(),
          buildMember({
            id: 'member-2',
            userId: 'user-2',
            projectId: 'project-created',
            user: { id: 'user-2', email: 'user2@example.com', phone: null },
            project: { id: 'project-created', name: 'Shared workspace' },
          }),
        ],
      } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        createProjectName: 'Shared workspace',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-2',
        name: 'Shared workspace',
      },
      select: { id: true },
    });
    expect(db.project.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-2',
        name: 'Shared workspace',
        daemonHost: null,
        workspacePath: null,
        metadata: null,
        collaborationId: 'collab-1',
        sortOrder: 2,
      }),
      select: { id: true },
    });
    expect(db.collaborationMember.create).toHaveBeenCalledWith({
      data: {
        collaborationId: 'collab-1',
        userId: 'user-2',
        projectId: 'project-created',
      },
    });
    expect(db.project.update).not.toHaveBeenCalled();
    expect(data.projectId).toBe('project-created');
  });

  it('rejects creating a project when any project already uses the suggested name', async () => {
    vi.mocked(db.projectCollaboration.findUnique).mockResolvedValueOnce({
      id: 'collab-1',
      members: [buildMember()],
    } as any);
    vi.mocked(db.project.findFirst).mockResolvedValueOnce({
      id: 'existing-project',
      daemonHost: 'qa-daemon-2',
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        createProjectName: 'conductor',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Project name already exists');
    expect(db.project.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-2',
        name: 'conductor',
      },
      select: { id: true },
    });
    expect(db.project.create).not.toHaveBeenCalled();
    expect(db.collaborationMember.create).not.toHaveBeenCalled();
  });

  it('rejects joining with the user default project', async () => {
    vi.mocked(db.projectCollaboration.findUnique).mockResolvedValueOnce({
      id: 'collab-1',
      members: [],
    } as any);
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'project-default',
      collaborationId: null,
      defaultProject: { id: 'default-project-1' },
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        projectId: 'project-default',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toContain('default project');
    expect(db.collaborationMember.create).not.toHaveBeenCalled();
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it('returns 410 when the invited collaboration was deleted between findUnique and the FK insert', async () => {
    // findUnique inside the transaction sees the collaboration; concurrent
    // last-member leave then deletes it; the FK insert fails with P2003.
    vi.mocked(db.projectCollaboration.findUnique).mockResolvedValueOnce({
      id: 'collab-stale',
      members: [],
    } as any);
    vi.mocked(db.collaborationMember.create).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed on the field: `collaboration_id`',
        { code: 'P2003', clientVersion: 'test' },
      ),
    );

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        projectId: 'project-2',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(410);
    expect(data.error).toContain('no longer valid');
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it('rejects joins when the collaboration already has five members', async () => {
    vi.mocked(db.projectCollaboration.findUnique).mockResolvedValueOnce({
      id: 'collab-full',
      members: Array.from({ length: 5 }, (_, index) => ({
        userId: `member-user-${index}`,
        projectId: `project-${index}`,
      })),
    } as any);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        projectId: 'project-2',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Collaboration is full');
    expect(db.collaborationMember.create).not.toHaveBeenCalled();
  });

  it('rolls back when a concurrent join pushes the member count over the cap', async () => {
    vi.mocked(db.projectCollaboration.findUnique).mockResolvedValueOnce({
      id: 'collab-nearly-full',
      members: Array.from({ length: 4 }, (_, index) => ({
        userId: `member-user-${index}`,
        projectId: `project-${index}`,
      })),
    } as any);
    vi.mocked(db.collaborationMember.count).mockResolvedValue(6);

    const response = await POST(createMockRequest({
      method: 'POST',
      body: {
        inviteToken: 'invite-token',
        projectId: 'project-2',
      },
    }));
    const data = await extractJson(response);

    expect(response.status).toBe(409);
    expect(data.error).toBe('Collaboration is full');
    expect(db.collaborationMember.create).toHaveBeenCalled();
    expect(db.project.update).not.toHaveBeenCalled();
  });
});

import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';
import { createMockRequest, extractJson } from '@/__tests__/helpers';

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: vi.fn(),
    project: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    projectCollaboration: {
      create: vi.fn(),
    },
  },
}));

const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');
const { db } = await import('@/lib/db');

describe('/api/projects/[projectId]/collaboration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-1' } as any);
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) =>
      callback({
        project: db.project,
        projectCollaboration: db.projectCollaboration,
      }),
    );
    vi.mocked(db.project.update).mockResolvedValue({ id: 'project-1' } as any);
  });

  it('rejects starting a collaboration on the user default project', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'project-default',
      collaborationId: null,
      collaboration: null,
      defaultProject: { id: 'default-project-1' },
    } as any);

    const response = await POST(
      createMockRequest({
        method: 'POST',
        url: 'http://localhost:6152/api/projects/project-default/collaboration',
      }),
      { params: Promise.resolve({ projectId: 'project-default' }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(400);
    expect(data.error).toContain('default project');
    expect(db.projectCollaboration.create).not.toHaveBeenCalled();
    expect(db.project.update).not.toHaveBeenCalled();
  });

  it('creates a collaboration and returns an invite URL for the owned project', async () => {
    vi.mocked(db.project.findFirst).mockResolvedValue({
      id: 'project-1',
      collaborationId: null,
      collaboration: null,
      defaultProject: null,
    } as any);
    vi.mocked(db.projectCollaboration.create).mockResolvedValue({
      id: 'collab-1',
      inviteToken: 'invite-token',
      createdAt: new Date('2026-05-03T00:00:00.000Z'),
      members: [
        {
          id: 'member-1',
          userId: 'user-1',
          projectId: 'project-1',
          joinedAt: new Date('2026-05-03T00:00:00.000Z'),
          user: { id: 'user-1', email: 'user@example.com', phone: null },
          project: { id: 'project-1', name: 'Project One' },
        },
      ],
    } as any);

    const response = await POST(
      createMockRequest({
        method: 'POST',
        url: 'http://localhost:6152/api/projects/project-1/collaboration',
      }),
      { params: Promise.resolve({ projectId: 'project-1' }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(db.projectCollaboration.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        inviteToken: expect.any(String),
        members: {
          create: {
            userId: 'user-1',
            projectId: 'project-1',
          },
        },
      }),
    }));
    expect(db.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { collaborationId: 'collab-1' },
    });
    expect(data.inviteUrl).toBe('http://localhost:6152/app/invite/invite-token');
  });

  describe('invite URL origin precedence', () => {
    const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;
    const originalPublicUrl = process.env.NEXT_PUBLIC_URL;

    afterEach(() => {
      if (originalBaseUrl === undefined) {
        delete process.env.NEXT_PUBLIC_BASE_URL;
      } else {
        process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
      }
      if (originalPublicUrl === undefined) {
        delete process.env.NEXT_PUBLIC_URL;
      } else {
        process.env.NEXT_PUBLIC_URL = originalPublicUrl;
      }
    });

    const setupOk = () => {
      vi.mocked(db.project.findFirst).mockResolvedValue({
        id: 'project-1',
        collaborationId: null,
        collaboration: null,
        defaultProject: null,
      } as any);
      vi.mocked(db.projectCollaboration.create).mockResolvedValue({
        id: 'collab-1',
        inviteToken: 'invite-token',
        createdAt: new Date('2026-05-03T00:00:00.000Z'),
        members: [
          {
            id: 'member-1',
            userId: 'user-1',
            projectId: 'project-1',
            joinedAt: new Date('2026-05-03T00:00:00.000Z'),
            user: { id: 'user-1', email: 'user@example.com', phone: null },
            project: { id: 'project-1', name: 'Project One' },
          },
        ],
      } as any);
    };

    it('prefers NEXT_PUBLIC_BASE_URL over the request Host so a spoofed Host header cannot phish collaborators', async () => {
      process.env.NEXT_PUBLIC_BASE_URL = 'https://app.example.com';
      setupOk();

      const response = await POST(
        createMockRequest({
          method: 'POST',
          // Attacker-controlled Host (e.g. via X-Forwarded-Host on a misconfigured proxy)
          url: 'http://attacker.evil/api/projects/project-1/collaboration',
        }),
        { params: Promise.resolve({ projectId: 'project-1' }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.inviteUrl).toBe('https://app.example.com/app/invite/invite-token');
    });

    it('falls back to the request URL when no PUBLIC_BASE_URL is configured (local dev)', async () => {
      delete process.env.NEXT_PUBLIC_BASE_URL;
      delete process.env.NEXT_PUBLIC_URL;
      setupOk();

      const response = await POST(
        createMockRequest({
          method: 'POST',
          url: 'http://localhost:6152/api/projects/project-1/collaboration',
        }),
        { params: Promise.resolve({ projectId: 'project-1' }) },
      );
      const data = await extractJson(response);

      expect(response.status).toBe(200);
      expect(data.inviteUrl).toBe('http://localhost:6152/app/invite/invite-token');
    });
  });

  it('returns the existing collaboration when a concurrent owner-side create races on the unique constraint', async () => {
    // First lookup inside the transaction sees no collaboration; the
    // transaction body then loses the race on unique-constraint and throws
    // P2002. The catch block must re-fetch the now-existing collaboration.
    vi.mocked(db.project.findFirst)
      .mockResolvedValueOnce({
        id: 'project-1',
        collaborationId: null,
        collaboration: null,
        defaultProject: null,
      } as any)
      .mockResolvedValueOnce({
        collaboration: {
          id: 'collab-existing',
          inviteToken: 'race-token',
          createdAt: new Date('2026-05-03T00:00:00.000Z'),
          members: [
            {
              id: 'member-1',
              userId: 'user-1',
              projectId: 'project-1',
              joinedAt: new Date('2026-05-03T00:00:00.000Z'),
              user: { id: 'user-1', email: 'user@example.com', phone: null },
              project: { id: 'project-1', name: 'Project One' },
            },
          ],
        },
      } as any);
    vi.mocked(db.projectCollaboration.create).mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const response = await POST(
      createMockRequest({
        method: 'POST',
        url: 'http://localhost:6152/api/projects/project-1/collaboration',
      }),
      { params: Promise.resolve({ projectId: 'project-1' }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.inviteUrl).toBe('http://localhost:6152/app/invite/race-token');
    expect(data.collaboration.id).toBe('collab-existing');
  });
});

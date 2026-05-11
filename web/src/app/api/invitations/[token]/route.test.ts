import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { createMockRequest, extractJson } from '@/__tests__/helpers';

vi.mock('@/lib/auth/middleware', () => ({
  getActiveSubscriptionUser: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: {
    projectCollaboration: {
      findUnique: vi.fn(),
    },
    project: {
      findMany: vi.fn(),
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
    email: 'owner@example.com',
    phone: null,
  },
  project: {
    id: 'project-1',
    name: 'conductor',
  },
  ...overrides,
});

const buildCollaboration = () => ({
  id: 'collab-1',
  inviteToken: 'invite-token',
  createdAt: new Date('2026-05-03T00:00:00.000Z'),
  members: [buildMember()],
});

describe('/api/invitations/[token]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-2' } as any);
    vi.mocked(db.projectCollaboration.findUnique).mockResolvedValue(buildCollaboration() as any);
  });

  it('marks the suggested project name unavailable when the default project already uses it', async () => {
    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: 'default-project',
        name: 'conductor',
        daemonHost: null,
        workspacePath: null,
        collaborationId: null,
        defaultProject: { id: 'default-project' },
      },
      {
        id: 'other-project',
        name: 'other',
        daemonHost: null,
        workspacePath: null,
        collaborationId: null,
        defaultProject: null,
      },
    ] as any);

    const response = await GET(
      createMockRequest({ url: 'http://localhost:6152/api/invitations/invite-token' }),
      { params: Promise.resolve({ token: 'invite-token' }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.suggestedProjectName).toBe('conductor');
    expect(data.suggestedProjectNameExists).toBe(true);
    expect(data.suggestedProjectNameAvailable).toBe(false);
    expect(data.suggested_project_name_exists).toBe(true);
    expect(data.candidateProjects).toHaveLength(1);
    expect(data.candidateProjects[0].id).toBe('other-project');
  });

  it('returns same-name non-default projects as joinable instead of encouraging duplicate creation', async () => {
    vi.mocked(db.project.findMany).mockResolvedValue([
      {
        id: 'project-2',
        name: 'conductor',
        daemonHost: 'local-daemon',
        workspacePath: '/repo/conductor',
        collaborationId: null,
        defaultProject: null,
      },
    ] as any);

    const response = await GET(
      createMockRequest({ url: 'http://localhost:6152/api/invitations/invite-token' }),
      { params: Promise.resolve({ token: 'invite-token' }) },
    );
    const data = await extractJson(response);

    expect(response.status).toBe(200);
    expect(data.suggestedProjectNameExists).toBe(true);
    expect(data.suggestedProjectNameAvailable).toBe(false);
    expect(data.candidateProjects).toEqual([
      expect.objectContaining({
        id: 'project-2',
        name: 'conductor',
        canJoin: true,
        alreadyInCollaboration: false,
      }),
    ]);
  });
});

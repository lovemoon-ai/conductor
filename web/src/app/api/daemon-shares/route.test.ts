import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({
  daemonShare: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  $transaction: vi.fn(),
}));
const hasAgentHost = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ db: mockDb }));
vi.mock('@/lib/realtime/hub', () => ({ realtimeHub: { hasAgentHost } }));
vi.mock('@/lib/auth/middleware', () => ({ getActiveSubscriptionUser: vi.fn() }));

const { POST } = await import('@/app/api/daemon-shares/route');
const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');

const request = (daemonHost: string) =>
  new Request('http://localhost/api/daemon-shares', {
    method: 'POST',
    body: JSON.stringify({ daemonHost }),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveSubscriptionUser).mockResolvedValue({ id: 'user-b' } as never);
  hasAgentHost.mockReturnValue(true);
  mockDb.daemonShare.findMany.mockResolvedValue([]);
  mockDb.$transaction.mockImplementation(async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb));
  mockDb.daemonShare.create.mockResolvedValue({
    id: 'share-1',
    ownerDaemonHost: 'bob-mbp',
    guestHost: null,
    status: 'pending',
    workspaceRoot: null,
    createdAt: new Date(),
    expiresAt: null,
    acceptedAt: null,
    revokedAt: null,
    inviteToken: 'tok',
    grantee: null,
  });
  mockDb.daemonShare.count.mockResolvedValue(1);
});

describe('POST /api/daemon-shares', () => {
  it('refuses to lend a daemon that was lent to the caller', async () => {
    // The guest daemon connects as the grantee, so it looks online and owned.
    mockDb.daemonShare.findMany.mockResolvedValue([{ guestHost: 'shared-alice-alice-mbp' }]);

    const response = await POST(request('shared-alice-alice-mbp'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'You cannot lend on a daemon lent to you' });
    expect(mockDb.daemonShare.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ granteeUserId: 'user-b', status: 'active' }),
      }),
    );
    expect(mockDb.daemonShare.create).not.toHaveBeenCalled();
  });

  it('creates an invite for an own online daemon', async () => {
    const response = await POST(request('bob-mbp'));

    expect(response.status).toBeLessThan(300);
    expect(mockDb.daemonShare.create).toHaveBeenCalled();
  });
});

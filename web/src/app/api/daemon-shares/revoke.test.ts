import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({
  daemonShare: { findUnique: vi.fn(), update: vi.fn() },
  userToken: { updateMany: vi.fn() },
  agentOutbox: { deleteMany: vi.fn() },
}));
const mockHub = vi.hoisted(() => ({
  getAgentsForUser: vi.fn(),
  takeOverAgentHost: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));
vi.mock('@/lib/realtime/hub', () => ({ realtimeHub: mockHub }));
vi.mock('@/lib/auth/middleware', () => ({ getActiveSubscriptionUser: vi.fn() }));

const { DELETE } = await import('@/app/api/daemon-shares/[id]/route');
const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');

describe('DELETE /api/daemon-shares/[id]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: 'user-a',
      email: null,
      phone: null,
    } as never);
    mockDb.daemonShare.findUnique.mockResolvedValue({
      id: 'share-1',
      ownerUserId: 'user-a',
      granteeUserId: 'user-b',
      guestHost: 'shared-alice-mbp',
      tokenId: 'tok-1',
      status: 'active',
    });
    mockDb.daemonShare.update.mockResolvedValue({});
    mockDb.userToken.updateMany.mockResolvedValue({ count: 1 });
    mockDb.agentOutbox.deleteMany.mockResolvedValue({ count: 0 });
  });

  const run = () =>
    DELETE({} as never, { params: Promise.resolve({ id: 'share-1' }) });

  it('closes the fire connections the guest launched, not just the daemon', async () => {
    // Verified live before this test existed: revoking dropped the guest daemon
    // socket in the same second but left a `conductor-fire-<guestHost>-<task>`
    // socket connected indefinitely, still holding the revoked credential.
    mockHub.getAgentsForUser.mockReturnValue([
      { host: 'shared-alice-mbp' },
      { host: 'conductor-fire-shared-alice-mbp-task-1' },
      { host: 'bob-macbook' }, // the grantee's own machine -- must be untouched
    ]);

    await run();

    const closed = mockHub.takeOverAgentHost.mock.calls.map((c) => c[0]);
    expect(closed).toContain('shared-alice-mbp');
    expect(closed).toContain('conductor-fire-shared-alice-mbp-task-1');
    expect(closed).not.toContain('bob-macbook');
  });

  it('drains queued commands for the fire hosts too', async () => {
    mockHub.getAgentsForUser.mockReturnValue([
      { host: 'conductor-fire-shared-alice-mbp-task-1' },
    ]);

    await run();

    const where = mockDb.agentOutbox.deleteMany.mock.calls[0][0].where;
    expect(where.userId).toBe('user-b');
    expect(where.agentHost.in).toEqual(
      expect.arrayContaining([
        'conductor-fire-shared-alice-mbp-task-1',
        'shared-alice-mbp',
      ]),
    );
  });

  it('still clears the guest host when it is currently offline', async () => {
    // An offline guest is absent from the live agent list, but its queued
    // commands must not be left waiting for a daemon that will never return.
    mockHub.getAgentsForUser.mockReturnValue([]);

    await run();

    expect(mockDb.agentOutbox.deleteMany.mock.calls[0][0].where.agentHost.in).toEqual([
      'shared-alice-mbp',
    ]);
  });

  it('refuses a share the caller neither owns nor was granted', async () => {
    vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
      id: 'user-c',
      email: null,
      phone: null,
    } as never);

    const response = await run();

    expect(response.status).toBe(404);
    expect(mockDb.daemonShare.update).not.toHaveBeenCalled();
  });
});

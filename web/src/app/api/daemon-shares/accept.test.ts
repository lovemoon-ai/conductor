import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDb = vi.hoisted(() => ({
  daemonShare: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
  },
  userToken: { update: vi.fn() },
}));
const issueApiToken = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ db: mockDb }));
vi.mock('@/lib/auth/service', () => ({ issueApiToken }));
vi.mock('@/lib/auth/middleware', () => ({ getActiveSubscriptionUser: vi.fn() }));

const { POST } = await import('@/app/api/daemon-shares/accept/[token]/route');
const { getActiveSubscriptionUser } = await import('@/lib/auth/middleware');

const MINUTE = 60_000;
const params = Promise.resolve({ token: 'invite-token' });
const request = () => new Request('http://localhost/api/daemon-shares/accept/invite-token', {
  method: 'POST',
}) as never;

const pendingShare = (expiresAt: Date | null) => ({
  id: 'share-1',
  ownerUserId: 'user-a',
  ownerDaemonHost: 'alice-mbp',
  status: 'pending',
  expiresAt,
  owner: { id: 'user-a', email: 'alice@example.com', phone: null },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getActiveSubscriptionUser).mockResolvedValue({
    id: 'user-b',
    email: 'bob@example.com',
    phone: null,
  } as never);
  mockDb.daemonShare.findMany.mockResolvedValue([]);
  mockDb.daemonShare.updateMany.mockResolvedValue({ count: 1 });
  mockDb.userToken.update.mockResolvedValue({});
  mockDb.daemonShare.findUniqueOrThrow.mockResolvedValue({
    id: 'share-1',
    ownerDaemonHost: 'alice-mbp',
    guestHost: 'shared-alice-alice-mbp',
    status: 'active',
    workspaceRoot: null,
    createdAt: new Date(),
    expiresAt: null,
    acceptedAt: new Date(),
    revokedAt: null,
    owner: { id: 'user-a', email: 'alice@example.com', phone: null },
  });
  issueApiToken.mockResolvedValue({ token: 'raw-token', tokenId: 'tok-1' });
});

describe('POST /api/daemon-shares/accept/[token] — invite expiry', () => {
  it('accepts an invite that is still inside its window', async () => {
    mockDb.daemonShare.findUnique.mockResolvedValue(pendingShare(new Date(Date.now() + MINUTE)));

    const response = await POST(request(), { params });

    expect(response.status).toBe(200);
    expect(mockDb.daemonShare.updateMany).toHaveBeenCalled();
  });

  it('refuses an expired invite without minting a credential', async () => {
    mockDb.daemonShare.findUnique.mockResolvedValue(pendingShare(new Date(Date.now() - 1)));

    const response = await POST(request(), { params });

    expect(response.status).toBe(410);
    // Minting first and revoking after would leave a live token in the window
    // between the two writes.
    expect(issueApiToken).not.toHaveBeenCalled();
    expect(mockDb.daemonShare.updateMany).not.toHaveBeenCalled();
  });

  it('refuses an invite predating expiry, rather than treating null as forever', async () => {
    mockDb.daemonShare.findUnique.mockResolvedValue(pendingShare(null));

    const response = await POST(request(), { params });

    expect(response.status).toBe(410);
    expect(issueApiToken).not.toHaveBeenCalled();
  });

  it('re-checks the deadline inside the claim, not just before it', async () => {
    // The read and the write are separate round trips. Without the deadline in
    // the update filter, a link that lapses in between would still be redeemed.
    mockDb.daemonShare.findUnique.mockResolvedValue(pendingShare(new Date(Date.now() + MINUTE)));

    await POST(request(), { params });

    const where = mockDb.daemonShare.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: 'share-1', status: 'pending' });
    expect(where.expiresAt).toEqual({ gt: expect.any(Date) });
  });

  it('revokes the minted token when the claim matches nothing', async () => {
    mockDb.daemonShare.findUnique.mockResolvedValue(pendingShare(new Date(Date.now() + MINUTE)));
    mockDb.daemonShare.updateMany.mockResolvedValue({ count: 0 });

    const response = await POST(request(), { params });

    expect(response.status).toBe(409);
    expect(mockDb.userToken.update).toHaveBeenCalledWith({
      where: { id: 'tok-1' },
      data: { revokedAt: expect.any(Date) },
    });
  });
});

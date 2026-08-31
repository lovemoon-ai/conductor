import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock('@/shared/api/client', () => ({ getApiClient: () => api }));

const { useDaemonSharesStore, normalizeDaemonShare } = await import('./store');

const reset = () =>
  useDaemonSharesStore.setState({
    shares: [],
    loading: false,
    error: null,
    maxSharesPerDaemon: 3,
  });

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe('normalizeDaemonShare', () => {
  it('drops rows that cannot identify a share', () => {
    expect(normalizeDaemonShare(null)).toBeNull();
    expect(normalizeDaemonShare({ id: 's1' })).toBeNull();
    expect(normalizeDaemonShare({ ownerDaemonHost: 'h' })).toBeNull();
  });

  it('defaults an unknown status to pending rather than trusting it', () => {
    const share = normalizeDaemonShare({
      id: 's1',
      ownerDaemonHost: 'alice-mbp',
      status: 'something-new',
    });
    expect(share?.status).toBe('pending');
  });

  it('keeps a not-yet-accepted share readable', () => {
    const share = normalizeDaemonShare({
      id: 's1',
      ownerDaemonHost: 'alice-mbp',
      status: 'pending',
      guestHost: null,
      granteeLabel: null,
    });
    expect(share).toMatchObject({ id: 's1', guestHost: null, granteeLabel: null });
  });
});

describe('useDaemonSharesStore', () => {
  it('loads shares and the per-daemon cap', async () => {
    api.get.mockResolvedValue({
      shares: [
        { id: 's1', ownerDaemonHost: 'alice-mbp', status: 'active', granteeLabel: 'bob' },
        { id: 'bad' },
      ],
      maxSharesPerDaemon: 3,
    });

    await useDaemonSharesStore.getState().fetchShares();

    const state = useDaemonSharesStore.getState();
    // The malformed row is dropped rather than rendered as a blank entry.
    expect(state.shares).toHaveLength(1);
    expect(state.shares[0].granteeLabel).toBe('bob');
    expect(state.maxSharesPerDaemon).toBe(3);
    expect(state.error).toBeNull();
  });

  it('surfaces a load failure instead of showing an empty list as success', async () => {
    api.get.mockRejectedValue(new Error('boom'));

    await useDaemonSharesStore.getState().fetchShares();

    expect(useDaemonSharesStore.getState().error).toBe('boom');
    expect(useDaemonSharesStore.getState().loading).toBe(false);
  });

  it('creates a share and appends it', async () => {
    api.post.mockResolvedValue({
      id: 's2',
      ownerDaemonHost: 'alice-mbp',
      status: 'pending',
      inviteToken: 'tok',
      inviteUrl: 'https://app.example/app/daemon-share/tok',
    });

    const share = await useDaemonSharesStore.getState().createShare('alice-mbp');

    expect(api.post).toHaveBeenCalledWith('/daemon-shares', { daemonHost: 'alice-mbp' });
    expect(share.inviteUrl).toBe('https://app.example/app/daemon-share/tok');
    expect(useDaemonSharesStore.getState().shares).toHaveLength(1);
  });

  it('removes the row on revoke', async () => {
    useDaemonSharesStore.setState({
      shares: [
        { id: 's1', ownerDaemonHost: 'a', status: 'active' },
        { id: 's2', ownerDaemonHost: 'a', status: 'active' },
      ] as never,
    });
    api.delete.mockResolvedValue({ ok: true });

    await useDaemonSharesStore.getState().revokeShare('s1');

    expect(api.delete).toHaveBeenCalledWith('/daemon-shares/s1');
    expect(useDaemonSharesStore.getState().shares.map((s) => s.id)).toEqual(['s2']);
  });

  it('keeps the list intact when revoke fails', async () => {
    useDaemonSharesStore.setState({
      shares: [{ id: 's1', ownerDaemonHost: 'a', status: 'active' }] as never,
    });
    api.delete.mockRejectedValue(new Error('nope'));

    await expect(useDaemonSharesStore.getState().revokeShare('s1')).rejects.toThrow('nope');
    // Removing it optimistically would tell the owner sharing had stopped when
    // it had not -- the one lie this screen must never tell.
    expect(useDaemonSharesStore.getState().shares).toHaveLength(1);
  });
});

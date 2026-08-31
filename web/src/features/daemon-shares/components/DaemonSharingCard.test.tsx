import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonSharingCard } from './DaemonSharingCard';
import type { DaemonShare } from '../store';

const store = vi.hoisted(() => ({
  shares: [] as DaemonShare[],
  fetchShares: vi.fn(),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
  maxSharesPerDaemon: 3,
}));
const pushToast = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const copyToClipboard = vi.hoisted(() => vi.fn());

vi.mock('../store', () => ({ useDaemonSharesStore: () => store }));
vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({ pushToast }),
  useConfirm: () => ({ confirm }),
}));
vi.mock('@/lib/clipboard', () => ({ copyToClipboard }));

const share = (overrides: Partial<DaemonShare> = {}): DaemonShare => ({
  id: 's1',
  ownerDaemonHost: 'alice-mbp',
  guestHost: null,
  status: 'pending',
  workspaceRoot: null,
  granteeLabel: null,
  ownerLabel: null,
  createdAt: '',
  // Comfortably inside the window unless a case overrides it.
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  acceptedAt: null,
  revokedAt: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.shares = [];
  store.maxSharesPerDaemon = 3;
  copyToClipboard.mockResolvedValue(true);
});

describe('DaemonSharingCard', () => {
  it('creates a share and copies the invite link', async () => {
    store.createShare.mockResolvedValue(
      share({ inviteUrl: 'https://app.example/app/daemon-share/tok' }),
    );

    render(<DaemonSharingCard agentHost="alice-mbp" />);
    fireEvent.click(screen.getByRole('button', { name: /Share alice-mbp/i }));

    expect(store.createShare).toHaveBeenCalledWith('alice-mbp');
    await waitFor(() =>
      expect(copyToClipboard).toHaveBeenCalledWith('https://app.example/app/daemon-share/tok'),
    );
  });

  it('lists only the shares belonging to this daemon', () => {
    store.shares = [
      share({ id: 's1', ownerDaemonHost: 'alice-mbp', granteeLabel: 'bob' }),
      share({ id: 's2', ownerDaemonHost: 'other-box', granteeLabel: 'carol' }),
    ];

    render(<DaemonSharingCard agentHost="alice-mbp" />);

    expect(screen.getByText('bob')).toBeInTheDocument();
    // The card is scoped to one machine; another daemon's grantee must not
    // appear here, or "Stop sharing" would revoke the wrong machine's share.
    expect(screen.queryByText('carol')).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 3 share slots used/)).toBeInTheDocument();
  });

  it('offers the invite link again while an invite is unaccepted', async () => {
    store.shares = [share({ inviteUrl: 'https://app.example/app/daemon-share/tok' })];

    render(<DaemonSharingCard agentHost="alice-mbp" />);
    // The link only reaches the clipboard once, at creation. Without this the
    // owner has to revoke and re-share to recover it.
    fireEvent.click(screen.getByRole('button', { name: /Copy the invite link/i }));

    expect(copyToClipboard).toHaveBeenCalledWith('https://app.example/app/daemon-share/tok');
  });

  it('keeps the share when the confirm dialog is dismissed', async () => {
    store.shares = [share({ granteeLabel: 'bob' })];
    confirm.mockResolvedValue(false);

    render(<DaemonSharingCard agentHost="alice-mbp" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(store.revokeShare).not.toHaveBeenCalled();
  });

  it('revokes after the owner confirms', async () => {
    store.shares = [share({ granteeLabel: 'bob' })];
    confirm.mockResolvedValue(true);
    store.revokeShare.mockResolvedValue(undefined);

    render(<DaemonSharingCard agentHost="alice-mbp" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

    await waitFor(() => expect(store.revokeShare).toHaveBeenCalledWith('s1'));
  });

  it('shows how long a pending invite has left', () => {
    store.shares = [share({ expiresAt: new Date(Date.now() + 125_000).toISOString() })];

    render(<DaemonSharingCard agentHost="alice-mbp" />);

    // A five-minute deadline the owner cannot see is a trap: they send the
    // link, the colleague opens it at lunch, and nobody knows why it failed.
    expect(screen.getByText(/Expires in 2m/)).toBeInTheDocument();
  });

  it('drops an invite whose window has closed instead of offering a dead link', () => {
    store.shares = [share({ expiresAt: new Date(Date.now() - 1000).toISOString() })];

    render(<DaemonSharingCard agentHost="alice-mbp" />);

    // The server already refuses this token. Still rendering "Copy link" would
    // hand the owner something that cannot work.
    expect(screen.getByText(/Not shared with anyone/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy the invite link/i })).not.toBeInTheDocument();
  });

  it('treats a pending invite with no deadline as already dead', () => {
    // Mirrors the server rule for rows written before expiry existed.
    store.shares = [share({ expiresAt: null })];

    render(<DaemonSharingCard agentHost="alice-mbp" />);

    expect(screen.getByText(/Not shared with anyone/)).toBeInTheDocument();
  });

  it('keeps showing an accepted share once its invite deadline is long past', () => {
    store.shares = [
      share({ status: 'active', granteeLabel: 'bob', expiresAt: new Date(Date.now() - 9e6).toISOString() }),
    ];

    render(<DaemonSharingCard agentHost="alice-mbp" />);

    // The deadline governs the link, not the access. Hiding an active share
    // would strand the owner with no way to revoke it.
    expect(screen.getByText('bob')).toBeInTheDocument();
  });

  it('stops at the per-daemon cap', () => {
    store.shares = [share({ id: 'a' }), share({ id: 'b' }), share({ id: 'c' })];

    render(<DaemonSharingCard agentHost="alice-mbp" />);

    expect(screen.getByRole('button', { name: /Share alice-mbp/i })).toBeDisabled();
  });

  it('shows a borrowed machine as read-only', () => {
    render(<DaemonSharingCard agentHost="shared-alice-alice-mbp" shared ownerLabel="alice" />);

    expect(screen.getByText(/Lent to you by/)).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();
    // You cannot lend on a machine that is not yours, and the list endpoint
    // returns nothing for a grantee, so there is nothing to fetch either.
    expect(screen.queryByRole('button', { name: /Share /i })).not.toBeInTheDocument();
    expect(store.fetchShares).not.toHaveBeenCalled();
  });
});

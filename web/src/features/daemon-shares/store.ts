import { create } from 'zustand';
import { getApiClient } from '@/shared/api/client';

/**
 * RFC 0035 — owner-side state for lending a daemon to a colleague.
 *
 * Deliberately mirrors `features/projects` collaboration: create a share, copy
 * the resulting invite link, revoke it later. Keeping the two flows shaped the
 * same means "share a machine" reads like "share a project" to anyone who has
 * used the latter.
 */

export type DaemonShare = {
  id: string;
  ownerDaemonHost: string;
  guestHost: string | null;
  status: 'pending' | 'active' | 'revoked';
  workspaceRoot: string | null;
  /** Never a raw email/phone — the API only ever returns a display label. */
  granteeLabel: string | null;
  ownerLabel: string | null;
  createdAt: string;
  /** When an unaccepted invite link stops working. Null once accepted. */
  expiresAt: string | null;
  acceptedAt: string | null;
  revokedAt: string | null;
  inviteToken?: string;
  inviteUrl?: string;
};

const pickString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value : null;

export const normalizeDaemonShare = (raw: unknown): DaemonShare | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record.id);
  const ownerDaemonHost = pickString(record.ownerDaemonHost);
  if (!id || !ownerDaemonHost) return null;
  const status = pickString(record.status);
  return {
    id,
    ownerDaemonHost,
    guestHost: pickString(record.guestHost),
    status: (status === 'active' || status === 'revoked' ? status : 'pending') as DaemonShare['status'],
    workspaceRoot: pickString(record.workspaceRoot),
    granteeLabel: pickString(record.granteeLabel),
    ownerLabel: pickString(record.ownerLabel),
    createdAt: pickString(record.createdAt) ?? '',
    expiresAt: pickString(record.expiresAt),
    acceptedAt: pickString(record.acceptedAt),
    revokedAt: pickString(record.revokedAt),
    inviteToken: pickString(record.inviteToken) ?? undefined,
    inviteUrl: pickString(record.inviteUrl) ?? undefined,
  };
};

interface DaemonSharesState {
  shares: DaemonShare[];
  loading: boolean;
  error: string | null;
  maxSharesPerDaemon: number;
  fetchShares: () => Promise<void>;
  createShare: (daemonHost: string) => Promise<DaemonShare>;
  revokeShare: (shareId: string) => Promise<void>;
}

export const useDaemonSharesStore = create<DaemonSharesState>((set, get) => ({
  shares: [],
  loading: false,
  error: null,
  maxSharesPerDaemon: 3,

  fetchShares: async () => {
    set({ loading: true, error: null });
    try {
      const body = await getApiClient().get<{
        shares?: unknown[];
        maxSharesPerDaemon?: number;
      }>('/daemon-shares');
      set({
        shares: (body?.shares ?? [])
          .map(normalizeDaemonShare)
          .filter((share): share is DaemonShare => share !== null),
        maxSharesPerDaemon: body?.maxSharesPerDaemon ?? 3,
        loading: false,
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to load daemon shares',
      });
    }
  },

  createShare: async (daemonHost) => {
    const raw = await getApiClient().post<unknown>('/daemon-shares', { daemonHost });
    const share = normalizeDaemonShare(raw);
    if (!share) throw new Error('Unexpected response from server');
    set({ shares: [...get().shares, share] });
    return share;
  },

  revokeShare: async (shareId) => {
    await getApiClient().delete(`/daemon-shares/${encodeURIComponent(shareId)}`);
    // Dropped rather than marked revoked: a revoked share is not actionable and
    // the list is "who can currently use my machine".
    set({ shares: get().shares.filter((share) => share.id !== shareId) });
  },
}));

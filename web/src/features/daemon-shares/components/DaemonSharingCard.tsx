'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/common/SectionCard';
import { useConfirm, useToast } from '@/components/common/FeedbackProvider';
import { copyToClipboard } from '@/lib/clipboard';
import { useDaemonSharesStore } from '../store';
import type { DaemonShare } from '../store';

interface DaemonSharingCardProps {
  agentHost: string;
  /** True when this machine was lent to the viewer by someone else. */
  shared?: boolean;
  ownerLabel?: string | null;
}

const inviteUrlFor = (share: DaemonShare): string => {
  const fromServer = share.inviteUrl?.trim();
  if (fromServer) return fromServer;
  if (typeof window === 'undefined' || !share.inviteToken) return '';
  return `${window.location.origin}/app/daemon-share/${encodeURIComponent(share.inviteToken)}`;
};

/**
 * Owner-side sharing controls for one daemon.
 *
 * Lives on the daemon's own page rather than the Settings root: sharing is a
 * property of a specific machine, and the root list is a navigation surface.
 */
export function DaemonSharingCard({ agentHost, shared, ownerLabel }: DaemonSharingCardProps) {
  const { shares, fetchShares, createShare, revokeShare, maxSharesPerDaemon } =
    useDaemonSharesStore();
  const { pushToast } = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // A borrowed machine has no owner-side shares to list, and the endpoint
    // only ever returns shares the caller owns.
    if (!shared) void fetchShares();
  }, [fetchShares, shared]);

  const hostShares = shares.filter((share) => share.ownerDaemonHost === agentHost);
  const atCap = hostShares.length >= maxSharesPerDaemon;

  const copyInvite = async (url: string, createdNow: boolean) => {
    const copied = url ? await copyToClipboard(url) : false;
    pushToast(copied
      ? {
        title: createdNow ? 'Share link copied' : 'Link copied',
        description: 'Send it to the person you want to lend this machine to.',
        variant: 'success',
      }
      : {
        title: createdNow ? 'Share link created' : 'Could not copy the link',
        description: url || 'Open this daemon again to retry.',
        variant: createdNow ? 'success' : 'error',
      });
  };

  const handleShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const share = await createShare(agentHost);
      await copyInvite(inviteUrlFor(share), true);
    } catch (error) {
      pushToast({
        title: 'Failed to create share link',
        description: error instanceof Error ? error.message : 'Try again later.',
        variant: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRevoke = async (share: DaemonShare) => {
    const who = share.granteeLabel ?? 'The invited person';
    const accepted = await confirm({
      title: 'Stop sharing?',
      description: `${who} will lose access to this machine. Anything running there for them is stopped.`,
      confirmLabel: 'Stop sharing',
      tone: 'danger',
    });
    if (!accepted) return;
    try {
      await revokeShare(share.id);
      pushToast({ title: 'Sharing stopped', variant: 'success' });
    } catch (error) {
      pushToast({
        title: 'Failed to stop sharing',
        description: error instanceof Error ? error.message : 'Try again later.',
        variant: 'error',
      });
    }
  };

  if (shared) {
    return (
      <SectionCard title="Sharing">
        <p className="text-sm text-muted">
          Lent to you by{' '}
          <span className="font-medium text-ink">{ownerLabel ?? 'a colleague'}</span>. Tasks you
          start here run on their machine, in their files, using the AI tools they have signed in
          to. You cannot lend it on.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Sharing"
      description="Let a colleague run tasks on this machine, with your files and your AI accounts."
      headerAction={
        <button
          type="button"
          onClick={() => void handleShare()}
          disabled={busy || atCap}
          aria-label={`Share ${agentHost} with a colleague`}
          title={atCap ? `Up to ${maxSharesPerDaemon} people can share one machine` : undefined}
          className="webapp-btn-primary shrink-0 px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Share'}
        </button>
      }
    >
      {hostShares.length === 0 ? (
        <p className="text-sm text-muted">
          Not shared with anyone. Share creates a link — whoever opens it gets this machine in
          their own daemon list.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {hostShares.map((share) => {
            const url = inviteUrlFor(share);
            return (
              <div key={share.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-ink">
                    {share.granteeLabel ?? 'Invite not accepted yet'}
                  </p>
                  {share.guestHost ? (
                    <p className="truncate font-mono text-xs text-muted">{share.guestHost}</p>
                  ) : null}
                </div>
                {/* A pending invite is useless if its link is lost -- it is
                    only ever put on the clipboard once, at creation. */}
                {!share.granteeLabel && url ? (
                  <button
                    type="button"
                    onClick={() => void copyInvite(url, false)}
                    aria-label={`Copy the invite link for ${agentHost}`}
                    className="shrink-0 text-xs text-muted hover:text-ink hover:underline"
                  >
                    Copy link
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void handleRevoke(share)}
                  className="shrink-0 text-xs text-[var(--error)] hover:underline"
                >
                  Stop sharing
                </button>
              </div>
            );
          })}
          <p className="pt-3 text-xs text-muted">
            {hostShares.length} of {maxSharesPerDaemon} share slots used.
          </p>
        </div>
      )}
    </SectionCard>
  );
}

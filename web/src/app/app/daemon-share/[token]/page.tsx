'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { InlineNotice } from '@/components/common/InlineNotice';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useToast } from '@/components/common/FeedbackProvider';
import { getApiClient } from '@/shared/api/client';

type DaemonShareInvite = {
  ownerLabel: string;
  ownerDaemonHost: string;
  workspaceRoot: string | null;
  status: 'pending' | 'active' | 'revoked';
  isSelf: boolean;
  alreadyAccepted: boolean;
  guestHost: string | null;
};

export default function DaemonShareInvitePage() {
  const params = useParams<{ token: string }>();
  const token = typeof params?.token === 'string' ? params.token : '';
  const router = useRouter();
  const { pushToast } = useToast();

  const [invite, setInvite] = useState<DaemonShareInvite | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getApiClient().get<DaemonShareInvite>(
          `/daemon-shares/invitations/${encodeURIComponent(token)}`,
        );
        if (!cancelled) setInvite(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Invitation not found');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleAccept = useCallback(async () => {
    setAccepting(true);
    try {
      const result = await getApiClient().post<{ guestHost: string }>(
        `/daemon-shares/accept/${encodeURIComponent(token)}`,
        {},
      );
      pushToast({
        variant: 'success',
        title: 'Connected',
        description: `The shared machine appears as ${result.guestHost}.`,
      });
      router.push('/app');
    } catch (err) {
      pushToast({
        variant: 'error',
        title: 'Could not accept the invitation',
        description: err instanceof Error ? err.message : undefined,
      });
      setAccepting(false);
    }
  }, [pushToast, router, token]);

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center">
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <Header />
      <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10">
        <h1 className="text-xl font-semibold">Use a shared machine</h1>

        {error && <InlineNotice variant="error">{error}</InlineNotice>}

        {invite && (
          <div className="mt-6 space-y-5">
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{invite.ownerLabel}</span> is offering
              you their machine{' '}
              <span className="font-mono text-foreground">{invite.ownerDaemonHost}</span>. Tasks you
              start on it run on their computer, in their filesystem, using the AI tools they have
              already signed in to.
            </p>

            {invite.workspaceRoot && (
              <p className="text-sm text-muted-foreground">
                Your workspace there will live under{' '}
                <span className="font-mono text-foreground">{invite.workspaceRoot}</span>.
              </p>
            )}

            {/*
              The grantee is trusting the owner's machine with their code, and
              the owner is trusting the grantee with shell access. Say so
              plainly rather than burying it -- this is a share-with-colleagues
              feature, not a sandbox.
            */}
            <InlineNotice variant="warning">
              Anything you run there has the same access as its owner: their files, their AI
              accounts, and their AI usage quota. Only accept from someone you work with.
            </InlineNotice>

            {invite.isSelf ? (
              <InlineNotice variant="info">This is your own daemon.</InlineNotice>
            ) : invite.alreadyAccepted ? (
              <InlineNotice variant="info">
                {invite.guestHost
                  ? `Already connected as ${invite.guestHost}.`
                  : 'This invitation has already been accepted.'}
              </InlineNotice>
            ) : invite.status === 'revoked' ? (
              <InlineNotice variant="error">This invitation is no longer valid.</InlineNotice>
            ) : (
              <button
                type="button"
                onClick={handleAccept}
                disabled={accepting}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                {accepting ? 'Connecting…' : 'Accept and connect'}
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

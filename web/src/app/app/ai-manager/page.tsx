'use client';

import { Suspense, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { AiManagerPanel } from '@/features/ai-manager';
import { useAiManagerStore } from '@/features/ai-manager';
import { RefreshIcon } from '@/features/tasks';

function AiManagerPageInner() {
  const searchParams = useSearchParams();
  const agentHost = searchParams.get('agentHost') ?? undefined;

  const selectedHost = useAiManagerStore((s) => s.selectedHost);
  const setSelectedHost = useAiManagerStore((s) => s.setSelectedHost);
  const fetchAll = useAiManagerStore((s) => s.fetchAll);
  const fetchQuota = useAiManagerStore((s) => s.fetchQuota);
  const isLoading = useAiManagerStore((s) => {
    const host = selectedHost ?? agentHost;
    if (!host) return false;
    const l = s.byHost[host]?.loading;
    return Boolean(l?.status || l?.quota || l?.accounts);
  });

  // Mirror the URL agentHost into the store so the header refresh button works
  // even before the panel mounts.
  useEffect(() => {
    if (agentHost && agentHost !== selectedHost) {
      setSelectedHost(agentHost);
    }
  }, [agentHost, selectedHost, setSelectedHost]);

  const handleRefresh = () => {
    const host = selectedHost ?? agentHost;
    if (!host) return;
    void fetchAll(host);
    void fetchQuota(host, { forceRefresh: true });
  };

  return (
    <>
      <Header
        title="Settings - Daemon"
        compact
        actions={
          <button
            onClick={handleRefresh}
            disabled={isLoading}
            aria-label={isLoading ? 'Refreshing' : 'Refresh'}
            title={isLoading ? 'Refreshing' : 'Refresh'}
            className="flex items-center justify-center rounded-lg bg-paper/80 p-2 text-sm text-muted transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshIcon spinning={isLoading} />
          </button>
        }
      />
      <div className="flex-1 overflow-y-auto p-4 webapp-scrollbar">
        <AiManagerPanel initialAgentHost={agentHost} />
      </div>
    </>
  );
}

export default function AiManagerPage() {
  return (
    <Suspense fallback={null}>
      <AiManagerPageInner />
    </Suspense>
  );
}

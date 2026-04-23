'use client';

import { Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { AiManagerPanel } from '@/features/ai-manager';
import { useAiManagerStore } from '@/features/ai-manager';
import { SETTINGS_ROOT_PATH, useSettingsNavStore } from '@/features/settings';
import { RefreshIcon } from '@/features/tasks';

function AiManagerPageInner() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const agentHost = searchParams.get('agentHost') ?? undefined;

  const selectedHost = useAiManagerStore((s) => s.selectedHost);
  const setSelectedHost = useAiManagerStore((s) => s.setSelectedHost);
  const fetchAll = useAiManagerStore((s) => s.fetchAll);
  const fetchQuota = useAiManagerStore((s) => s.fetchQuota);
  const setLastSettingsPath = useSettingsNavStore((s) => s.setLastPath);
  // Track whether the URL host has already been force-refreshed this mount, so
  // we only do it once per "arrive at this daemon" event (not on every render).
  const lastForceRefreshedHostRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // Host we've already restored scroll for this mount — prevents double-restore
  // when subsequent renders arrive (e.g. when quota/accounts finish loading).
  const restoredScrollHostRef = useRef<string | null>(null);
  // True once the selected host has some primary content available (status).
  // We wait for this before restoring so scrollTop isn't silently clamped to
  // the (small) height of the loading state.
  const hostContentReady = useAiManagerStore((s) => {
    const host = agentHost ?? selectedHost;
    if (!host) return false;
    return s.byHost[host]?.status != null;
  });
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

  // Remember this Settings-area URL (pathname + query) so the sidebar Settings
  // item restores the user to this daemon when they come back from Issues/Tasks.
  useEffect(() => {
    const search = searchParams.toString();
    const path = search ? `${pathname}?${search}` : pathname;
    setLastSettingsPath(path);
  }, [pathname, searchParams, setLastSettingsPath]);

  // Auto-refresh when we arrive at (or switch to) a specific host. We only
  // force-refresh quota here — status/accounts and the initial quota fetch are
  // handled by AiManagerPanel on selectedHost change, so calling fetchAll here
  // would double-request. Using a ref-guard keeps this to exactly one
  // force-refresh per "arrive at this daemon" event.
  useEffect(() => {
    const host = agentHost ?? selectedHost;
    if (!host) return;
    if (lastForceRefreshedHostRef.current === host) return;
    lastForceRefreshedHostRef.current = host;
    void fetchQuota(host, { forceRefresh: true });
  }, [agentHost, selectedHost, fetchQuota]);

  // Persist the scrollTop of the daemon page body per host. We save on every
  // scroll (cheap — writes to an in-memory zustand slice), and one final time
  // on unmount / host-change. This lets the user bounce to Tasks/Issues and
  // return with their position preserved.
  useEffect(() => {
    const host = agentHost ?? selectedHost;
    const el = scrollContainerRef.current;
    if (!host || !el) return;
    const { setScrollForHost } = useSettingsNavStore.getState();
    const handleScroll = () => {
      setScrollForHost(host, el.scrollTop);
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      // Capture a final position on unmount / host change in case the user
      // navigated away mid-scroll (scroll events fire asynchronously).
      setScrollForHost(host, el.scrollTop);
      el.removeEventListener('scroll', handleScroll);
    };
  }, [agentHost, selectedHost]);

  // Restore the remembered scroll position once the host's content is ready.
  // useLayoutEffect so the user doesn't see a flash-of-top before the jump.
  useLayoutEffect(() => {
    const host = agentHost ?? selectedHost;
    if (!host || !hostContentReady) return;
    if (restoredScrollHostRef.current === host) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const saved = useSettingsNavStore.getState().getScrollForHost(host);
    if (saved > 0) {
      el.scrollTop = saved;
    }
    restoredScrollHostRef.current = host;
  }, [agentHost, selectedHost, hostContentReady]);

  const handleRefresh = () => {
    const host = selectedHost ?? agentHost;
    if (!host) return;
    void fetchAll(host);
    void fetchQuota(host, { forceRefresh: true });
  };

  const handleBackToSettings = () => {
    router.push(SETTINGS_ROOT_PATH);
  };

  return (
    <>
      <Header
        title="Settings - Daemon"
        compact
        showBack
        onBack={handleBackToSettings}
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
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto p-4 webapp-scrollbar"
      >
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

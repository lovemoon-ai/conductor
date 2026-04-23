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
  // Flag set when we arrive at a new host and still want to restore scroll.
  // Cleared once we've consumed the saved position (or given up).
  const pendingRestoreHostRef = useRef<string | null>(null);
  // Subscribe to the whole per-host state so the restore useLayoutEffect fires
  // again each time a piece of data (status/quota/accounts) arrives, giving it
  // chances to retry as content height grows. Identity-compare is enough here;
  // we don't care about the contents, only "something changed".
  const hostState = useAiManagerStore((s) => {
    const host = agentHost ?? selectedHost;
    return host ? s.byHost[host] : undefined;
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
  // scroll (cheap — writes to an in-memory zustand slice), plus a final
  // snapshot on unmount / host-change, plus on visibility/pagehide so we don't
  // lose state when the browser tab goes to the background on mobile.
  useEffect(() => {
    const host = agentHost ?? selectedHost;
    const el = scrollContainerRef.current;
    if (!host || !el) return;
    const save = () => {
      useSettingsNavStore.getState().setScrollForHost(host, el.scrollTop);
    };
    el.addEventListener('scroll', save, { passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      // Capture a final position on unmount / host change in case the user
      // navigated away mid-scroll (scroll events fire asynchronously).
      save();
      el.removeEventListener('scroll', save);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
    };
  }, [agentHost, selectedHost]);

  // Mark "should restore" whenever we arrive at a new host. A separate effect
  // (below) consumes this flag across as many renders as needed to land the
  // scrollTop, because the panel's content height grows in stages as status /
  // quota / accounts data arrives.
  useLayoutEffect(() => {
    const host = agentHost ?? selectedHost;
    if (!host) return;
    if (pendingRestoreHostRef.current === host) return;
    pendingRestoreHostRef.current = host;
  }, [agentHost, selectedHost]);

  // Attempt to restore scrollTop on every render where there's a pending host.
  // Dependency includes `hostState` so this re-fires each time the per-host
  // store slice changes (status/quota/accounts arrive), retrying the restore
  // until scrollHeight is tall enough to accommodate the saved position. Once
  // we land the exact saved value — or we're clamped by a genuinely shorter
  // page — we clear the pending flag. useLayoutEffect so no flash-of-top.
  useLayoutEffect(() => {
    const host = pendingRestoreHostRef.current;
    if (!host) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const saved = useSettingsNavStore.getState().getScrollForHost(host);
    if (saved <= 0) {
      // Nothing to restore; mark done so we don't keep re-running on future renders.
      pendingRestoreHostRef.current = null;
      return;
    }
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    if (max <= 0) {
      // Content isn't scrollable yet — wait for a later render once data arrives.
      return;
    }
    const target = Math.min(saved, max);
    el.scrollTop = target;
    // If we hit the exact saved position, we're done. If `max < saved` we've
    // only reached the bottom of what's currently rendered; keep the pending
    // flag and let a later data-arrival render try again.
    if (max >= saved) {
      pendingRestoreHostRef.current = null;
    }
  }, [agentHost, selectedHost, hostState]);

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

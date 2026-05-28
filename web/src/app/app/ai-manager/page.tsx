'use client';

import { Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/layout/Header';
import { useAgentsStore } from '@/features/agents';
import { AiManagerPanel } from '@/features/ai-manager';
import { useAiManagerStore } from '@/features/ai-manager';
import { SETTINGS_ROOT_PATH, useSettingsNavStore } from '@/features/settings';
import { RefreshIcon } from '@/features/tasks';

// ---------- Daemon-page scroll persistence ----------
//
// Why this is so defensive:
//  - On iOS Safari the inner `<div overflow-y-auto>` and the document element
//    can both act as scroll containers depending on viewport / URL-bar state,
//    and we don't know in advance which one will see the user's scroll.
//  - Next.js App Router + browser history may apply their own scroll reset
//    shortly after our layout effects run.
//  - The store-held `byHost` data may still be warm, so AiManagerPanel's
//    content height can reach "tall" on the first render, OR it may grow
//    across several renders as quota/accounts responses arrive. Either way
//    we need to retry until we land close to the saved position.
//
// Storage: zustand slice for in-memory + sessionStorage for durability across
// unexpected remounts or zustand state drops. `sessionStorage` is the same
// mechanism the chat view uses, proven to survive `<Link>` navigation.

const SCROLL_STORAGE_PREFIX = 'conductor-daemon-scroll:';
const BUILT_IN_AI_BACKENDS = new Set(['codex', 'claude', 'kimi', 'copilot']);

function externalQuotaBackends(backends: string[] | undefined): string[] {
  return [...new Set(
    (backends ?? []).flatMap((backend) => {
      const normalized = backend.trim().toLowerCase();
      return normalized && !BUILT_IN_AI_BACKENDS.has(normalized) ? [normalized] : [];
    }),
  )];
}

function scrollStorageKey(host: string): string {
  return `${SCROLL_STORAGE_PREFIX}${host}`;
}

function readStoredScrollTop(host: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = window.sessionStorage.getItem(scrollStorageKey(host));
    if (!raw) return 0;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeStoredScrollTop(host: string, scrollTop: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(scrollStorageKey(host), String(Math.max(0, Math.floor(scrollTop))));
  } catch {
    // storage quota / disabled — ignore
  }
}

function currentScrollTop(div: HTMLElement | null): number {
  const divTop = div?.scrollTop ?? 0;
  const docTop =
    (typeof window !== 'undefined' ? window.scrollY : 0) ||
    (typeof document !== 'undefined' ? document.documentElement.scrollTop : 0) ||
    (typeof document !== 'undefined' ? document.body.scrollTop : 0) ||
    0;
  return Math.max(divTop, docTop);
}

function applyScrollTop(div: HTMLElement | null, target: number): void {
  if (div) {
    const divMax = Math.max(0, div.scrollHeight - div.clientHeight);
    if (divMax > 0) div.scrollTop = Math.min(target, divMax);
  }
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    const docMax = Math.max(
      0,
      document.documentElement.scrollHeight - document.documentElement.clientHeight,
    );
    if (docMax > 0) {
      window.scrollTo({ top: Math.min(target, docMax), left: 0 });
    }
  }
}

function AiManagerPageInner() {
  const { push } = useRouter();
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
  const selectedAgent = useAgentsStore((s) => {
    const host = selectedHost ?? agentHost;
    return host ? s.agents.find((agent) => agent.host === host) : undefined;
  });
  const externalBackendKey = externalQuotaBackends(selectedAgent?.supportedBackends).join(',');
  const externalBackends = externalBackendKey ? externalBackendKey.split(',') : [];
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
    const refreshKey = `${host}:${externalBackends.join(',') || 'base'}`;
    if (lastForceRefreshedHostRef.current === refreshKey) return;
    lastForceRefreshedHostRef.current = refreshKey;
    void fetchQuota(host, { forceRefresh: true, externalQuotaBackends: externalBackends });
  }, [agentHost, selectedHost, externalBackendKey, fetchQuota]);

  // Persist scrollTop per host. Listens on both the inner div AND window so we
  // capture whichever element the OS/browser actually scrolls — iOS Safari in
  // particular can scroll the document when `h-screen` disagrees with the
  // visual viewport. Writes go to zustand (fast in-memory) AND sessionStorage
  // (durable across any unexpected remount path).
  useEffect(() => {
    const host = agentHost ?? selectedHost;
    if (!host) return;
    const save = () => {
      const top = currentScrollTop(scrollContainerRef.current);
      useSettingsNavStore.getState().setScrollForHost(host, top);
      writeStoredScrollTop(host, top);
    };
    const div = scrollContainerRef.current;
    div?.addEventListener('scroll', save, { passive: true });
    window.addEventListener('scroll', save, { passive: true });
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => {
      save();
      div?.removeEventListener('scroll', save);
      window.removeEventListener('scroll', save);
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', save);
    };
  }, [agentHost, selectedHost]);

  // Mark "should restore" on arrival at a new host. Consumed by the restore
  // effect below.
  useLayoutEffect(() => {
    const host = agentHost ?? selectedHost;
    if (!host) return;
    if (pendingRestoreHostRef.current === host) return;
    pendingRestoreHostRef.current = host;
  }, [agentHost, selectedHost]);

  // Restore scrollTop. This has three layers of defence because the actual
  // behavior on mobile has proven fragile:
  //
  //   1. Synchronous useLayoutEffect — fast path, fires before paint. Depends
  //      on `hostState` so it re-runs as quota/accounts responses arrive and
  //      content grows taller.
  //
  //   2. rAF-driven retry loop — runs after paint for up to ~1s. Overrides
  //      any late scroll reset from Next.js's router, browser back-forward
  //      restoration, or iOS inertial scrolling. Gives up once we've landed
  //      within 2px of target or content simply isn't tall enough.
  //
  //   3. Both div AND window scrollTop are written on every attempt — we
  //      don't care which one is the real scroller on this device.
  useLayoutEffect(() => {
    const host = pendingRestoreHostRef.current;
    if (!host) return;

    // Prefer sessionStorage (survives more) but fall back to zustand.
    const savedFromStorage = readStoredScrollTop(host);
    const savedFromStore = useSettingsNavStore.getState().getScrollForHost(host);
    const saved = Math.max(savedFromStorage, savedFromStore);

    if (saved <= 0) {
      pendingRestoreHostRef.current = null;
      return;
    }

    applyScrollTop(scrollContainerRef.current, saved);

    const currentAfter = currentScrollTop(scrollContainerRef.current);
    const landed = currentAfter >= saved - 2;
    if (landed) {
      pendingRestoreHostRef.current = null;
    }

    // Post-paint retry loop — runs regardless of `landed` because Next.js or
    // browser history scroll-restore can clobber us after commit but before
    // our next layoutEffect gets a chance.
    let raf = 0;
    let attempts = 0;
    const maxAttempts = 60; // ~1s at 60fps
    const tick = () => {
      attempts += 1;
      applyScrollTop(scrollContainerRef.current, saved);
      const got = currentScrollTop(scrollContainerRef.current);
      if (got >= saved - 2) {
        pendingRestoreHostRef.current = null;
        return;
      }
      if (attempts < maxAttempts) {
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [agentHost, selectedHost, hostState]);

  const handleRefresh = () => {
    const host = selectedHost ?? agentHost;
    if (!host) return;
    void fetchAll(host, { externalQuotaBackends: externalBackends });
    void fetchQuota(host, { forceRefresh: true, externalQuotaBackends: externalBackends });
  };

  const handleBackToSettings = () => {
    push(SETTINGS_ROOT_PATH);
  };

  return (
    <>
      <Header
        title="Settings - Daemon"
        compact
        showBack
        onBack={handleBackToSettings}
        actions={
          <button type="button"
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

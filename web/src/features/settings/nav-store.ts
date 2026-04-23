import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

/**
 * The Settings "area" in the UI logically spans two physical routes:
 *   - /app/settings              (settings root: daemon list, build info, session)
 *   - /app/ai-manager?agentHost= (per-daemon management subpage)
 *
 * We remember the most recent Settings-area URL in localStorage so the
 * sidebar/mobile-nav Settings item can restore the user to where they left off
 * when they come back from Issues/Tasks. Clicking Settings while already inside
 * the area is treated as a reset — see Sidebar.tsx for the policy.
 */

export const SETTINGS_ROOT_PATH = '/app/settings';
export const AI_MANAGER_PATH_PREFIX = '/app/ai-manager';

export function isSettingsAreaPath(pathname: string): boolean {
  return (
    pathname === SETTINGS_ROOT_PATH ||
    pathname.startsWith(`${SETTINGS_ROOT_PATH}/`) ||
    pathname === AI_MANAGER_PATH_PREFIX ||
    pathname.startsWith(`${AI_MANAGER_PATH_PREFIX}/`) ||
    pathname.startsWith(`${AI_MANAGER_PATH_PREFIX}?`)
  );
}

interface SettingsNavState {
  /** Most recent Settings-area path (including query string), or null if the user hasn't visited yet. */
  lastPath: string | null;
  /**
   * Last known scrollTop of the AI Manager page body, keyed by agent host.
   * Transient — not persisted across reloads. Callers are expected to read/write
   * through `getScrollForHost` / `setScrollForHost` imperatively (via
   * `getState()`) rather than subscribing, to avoid a re-render on every
   * scroll event.
   */
  scrollByHost: Record<string, number>;
  setLastPath(path: string): void;
  setScrollForHost(host: string, scrollTop: number): void;
  getScrollForHost(host: string): number;
  reset(): void;
}

export const useSettingsNavStore = create<SettingsNavState>()(
  persist(
    (set, get) => ({
      lastPath: null,
      scrollByHost: {},
      setLastPath(path) {
        // Guard against garbage — we only care about Settings-area paths.
        if (!path.startsWith('/')) return;
        set({ lastPath: path });
      },
      setScrollForHost(host, scrollTop) {
        if (!host) return;
        // Clamp negatives (some browsers report rubber-band overscroll as <0).
        const normalized = Math.max(0, Math.floor(scrollTop));
        set({ scrollByHost: { ...get().scrollByHost, [host]: normalized } });
      },
      getScrollForHost(host) {
        if (!host) return 0;
        return get().scrollByHost[host] ?? 0;
      },
      reset() {
        set({ lastPath: null, scrollByHost: {} });
      },
    }),
    {
      name: 'conductor-settings-nav',
      storage: createJSONStorage(() => localStorage),
      // Only `lastPath` survives a reload. `scrollByHost` is transient —
      // persisting it would bloat storage and a full reload is a natural
      // "reset scroll" boundary anyway.
      partialize: (state) => ({ lastPath: state.lastPath }),
    },
  ),
);

/**
 * Pick the right Settings href to put on the sidebar item given the current pathname.
 *
 * Policy:
 *  - Outside the Settings area → jump to the remembered sub-path (default: settings root).
 *  - Already inside the Settings area → clicking "Settings" resets to the root.
 *    (From inside a daemon page, use the page's back button to explicitly return to the root;
 *    the sidebar item doing the same thing keeps its behavior predictable.)
 */
export function resolveSettingsHref(
  pathname: string,
  lastPath: string | null,
): string {
  if (isSettingsAreaPath(pathname)) {
    return SETTINGS_ROOT_PATH;
  }
  if (lastPath && isSettingsAreaPath(lastPath)) {
    return lastPath;
  }
  return SETTINGS_ROOT_PATH;
}

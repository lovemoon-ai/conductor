/**
 * Per-AI-task UI flag deciding which panel the detail pane shows:
 *   true  → render the attached PTY's TerminalView
 *   false → render the normal ChatView
 *
 * Persisted to localStorage so the user's last choice survives reload.
 *
 * This is intentionally a simple zustand store rather than URL state — the
 * choice should not pollute browser history when the user toggles back and
 * forth, and putting it in the URL would also change shareable links into
 * "the time I happened to be looking at the terminal" snapshots.
 */
import { create } from 'zustand';

const STORAGE_KEY = 'conductor.attached-terminal.ptyActive';

const readPersisted = (): Record<string, boolean> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof value === 'boolean') {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
};

const writePersisted = (value: Record<string, boolean>): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore quota / private-mode errors — the toggle still works in-memory.
  }
};

interface PtyToggleState {
  byAiTaskId: Record<string, boolean>;
  hasHydrated: boolean;
  isActive: (aiTaskId: string) => boolean;
  setActive: (aiTaskId: string, value: boolean) => void;
  toggle: (aiTaskId: string) => void;
  clear: (aiTaskId: string) => void;
  pruneMissing: (knownAiTaskIds: Iterable<string>) => void;
  /** Called once on the client to populate from localStorage post-mount. */
  hydrate: () => void;
}

/**
 * The store is created with an empty map so the server-rendered HTML is
 * deterministic; the client populates from localStorage via `hydrate()` on
 * first mount. Without this guard, components reading `byAiTaskId` during
 * SSR see `{}` and re-render after hydration with a different value,
 * causing a React hydration warning.
 */
export const usePtyToggleStore = create<PtyToggleState>((set, get) => ({
  byAiTaskId: {},
  hasHydrated: false,

  hydrate: () => {
    if (get().hasHydrated) return;
    set({ byAiTaskId: readPersisted(), hasHydrated: true });
  },

  isActive: (aiTaskId: string) => Boolean(get().byAiTaskId[aiTaskId]),

  setActive: (aiTaskId: string, value: boolean) => {
    set((state) => {
      const next = { ...state.byAiTaskId };
      if (value) {
        next[aiTaskId] = true;
      } else {
        delete next[aiTaskId];
      }
      writePersisted(next);
      return { byAiTaskId: next };
    });
  },

  toggle: (aiTaskId: string) => {
    const current = Boolean(get().byAiTaskId[aiTaskId]);
    get().setActive(aiTaskId, !current);
  },

  clear: (aiTaskId: string) => {
    set((state) => {
      if (!(aiTaskId in state.byAiTaskId)) return state;
      const next = { ...state.byAiTaskId };
      delete next[aiTaskId];
      writePersisted(next);
      return { byAiTaskId: next };
    });
  },

  pruneMissing: (knownAiTaskIds: Iterable<string>) => {
    const allowed = new Set(knownAiTaskIds);
    set((state) => {
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [key, value] of Object.entries(state.byAiTaskId)) {
        if (allowed.has(key)) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      if (!changed) return state;
      writePersisted(next);
      return { byAiTaskId: next };
    });
  },
}));

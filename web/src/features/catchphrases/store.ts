/**
 * Per-user catchphrase library (RFC 0032) — client store.
 *
 * Mirrors the server's source of truth. All mutating actions are optimistic
 * with rollback-on-failure (à la `features/user-preferences/store.ts`) and
 * use a sequence counter so a later in-flight mutation always wins over an
 * earlier one when both resolve out-of-order.
 *
 * Realtime: subscribe to `user_catchphrase_update` events (broadcast on
 * write by the server) and pipe payloads through `applyCatchphrases` so two
 * tabs of the same account stay in sync without manual refresh.
 */
import { create } from 'zustand';
import { ApiRequestError, getApiClient } from '@/shared/api/client';

export type Catchphrase = {
  id: string;
  text: string;
  sortOrder: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type CatchphrasesState = {
  catchphrases: Catchphrase[];
  hydrated: boolean;
  loading: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  create: (text: string) => Promise<Catchphrase | null>;
  update: (id: string, text: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  touch: (id: string) => Promise<void>;
  applyCatchphrases: (next: Catchphrase[]) => void;
  /** Clear all client state — used by auth.logout() to avoid leaking
   *  one user's catchphrases into the next account in the same tab. */
  reset: () => void;
};

let mutationSequence = 0;

const errorMessage = (error: unknown): string => {
  if (error instanceof ApiRequestError) {
    return error.payload.error || error.message;
  }
  return error instanceof Error ? error.message : 'Failed to sync catchphrases';
};

const normalizeCatchphrase = (value: unknown): Catchphrase | null => {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : null;
  const text = typeof record.text === 'string' ? record.text : null;
  if (!id || text === null) return null;
  const sortOrderRaw = record.sortOrder;
  const sortOrder = typeof sortOrderRaw === 'number' && Number.isFinite(sortOrderRaw) ? sortOrderRaw : 0;
  const lastUsedAt =
    typeof record.lastUsedAt === 'string' && record.lastUsedAt ? record.lastUsedAt : null;
  const createdAt = typeof record.createdAt === 'string' ? record.createdAt : '';
  const updatedAt = typeof record.updatedAt === 'string' ? record.updatedAt : '';
  return { id, text, sortOrder, lastUsedAt, createdAt, updatedAt };
};

export const normalizeCatchphrases = (value: unknown): Catchphrase[] => {
  if (!Array.isArray(value)) return [];
  const result: Catchphrase[] = [];
  for (const item of value) {
    const normalized = normalizeCatchphrase(item);
    if (normalized) result.push(normalized);
  }
  // Server already orders by sortOrder; re-sort defensively in case a payload
  // arrives unsorted.
  result.sort((a, b) => a.sortOrder - b.sortOrder);
  return result;
};

type ListResponse = { catchphrases?: unknown };

const fetchList = async (): Promise<Catchphrase[]> => {
  const response = (await getApiClient().get<ListResponse>('/user-preferences/catchphrases')) ?? {};
  return normalizeCatchphrases(response.catchphrases);
};

export const useCatchphrasesStore = create<CatchphrasesState>()((set, get) => ({
  catchphrases: [],
  hydrated: false,
  loading: false,
  error: null,

  hydrate: async () => {
    const sequenceAtStart = mutationSequence;
    set({ loading: true, error: null });
    try {
      const catchphrases = await fetchList();
      set((state) => ({
        catchphrases:
          mutationSequence === sequenceAtStart ? catchphrases : state.catchphrases,
        hydrated: true,
        loading: false,
        error: null,
      }));
    } catch (error) {
      set({
        hydrated: false,
        loading: false,
        error: errorMessage(error),
      });
    }
  },

  create: async (text) => {
    const trimmed = text.trim();
    if (!trimmed) return null;
    mutationSequence += 1;
    const sequence = mutationSequence;
    try {
      const response = (await getApiClient().post<ListResponse>(
        '/user-preferences/catchphrases',
        { text: trimmed },
      )) ?? {};
      const next = normalizeCatchphrases(response.catchphrases);
      set((state) => ({
        catchphrases: sequence === mutationSequence ? next : state.catchphrases,
        error: null,
      }));
      // Return the newly-created row (the highest sortOrder one) so the UI
      // can scroll to / focus it.
      return next.length > 0 ? next[next.length - 1] : null;
    } catch (error) {
      set({ error: errorMessage(error) });
      return null;
    }
  },

  update: async (id, text) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    mutationSequence += 1;
    const sequence = mutationSequence;
    const previous = get().catchphrases;
    // Optimistic update.
    set({
      catchphrases: previous.map((row) =>
        row.id === id ? { ...row, text: trimmed } : row,
      ),
      error: null,
    });
    try {
      const response = (await getApiClient().patch<ListResponse>(
        `/user-preferences/catchphrases/${encodeURIComponent(id)}`,
        { text: trimmed },
      )) ?? {};
      const next = normalizeCatchphrases(response.catchphrases);
      set((state) => ({
        catchphrases: sequence === mutationSequence ? next : state.catchphrases,
        error: null,
      }));
      return true;
    } catch (error) {
      set((state) => ({
        catchphrases: sequence === mutationSequence ? previous : state.catchphrases,
        error: errorMessage(error),
      }));
      return false;
    }
  },

  remove: async (id) => {
    mutationSequence += 1;
    const sequence = mutationSequence;
    const previous = get().catchphrases;
    // Optimistic remove.
    set({
      catchphrases: previous.filter((row) => row.id !== id),
      error: null,
    });
    try {
      const response = (await getApiClient().delete<ListResponse>(
        `/user-preferences/catchphrases/${encodeURIComponent(id)}`,
      )) ?? {};
      const next = normalizeCatchphrases(response.catchphrases);
      set((state) => ({
        catchphrases: sequence === mutationSequence ? next : state.catchphrases,
        error: null,
      }));
    } catch (error) {
      set((state) => ({
        catchphrases: sequence === mutationSequence ? previous : state.catchphrases,
        error: errorMessage(error),
      }));
    }
  },

  reorder: async (ids) => {
    mutationSequence += 1;
    const sequence = mutationSequence;
    const previous = get().catchphrases;
    // Optimistic reorder — preserve any rows whose id wasn't in the supplied
    // list at the tail, so a partial reorder doesn't drop entries.
    const byId = new Map(previous.map((row) => [row.id, row]));
    const reordered: Catchphrase[] = [];
    ids.forEach((id, index) => {
      const row = byId.get(id);
      if (row) {
        reordered.push({ ...row, sortOrder: index });
        byId.delete(id);
      }
    });
    let tailIndex = reordered.length;
    for (const row of byId.values()) {
      reordered.push({ ...row, sortOrder: tailIndex });
      tailIndex += 1;
    }
    set({ catchphrases: reordered, error: null });

    try {
      const response = (await getApiClient().put<ListResponse>(
        '/user-preferences/catchphrases/reorder',
        { ids },
      )) ?? {};
      const next = normalizeCatchphrases(response.catchphrases);
      set((state) => ({
        catchphrases: sequence === mutationSequence ? next : state.catchphrases,
        error: null,
      }));
    } catch (error) {
      set((state) => ({
        catchphrases: sequence === mutationSequence ? previous : state.catchphrases,
        error: errorMessage(error),
      }));
    }
  },

  touch: async (id) => {
    // Best-effort: bump lastUsedAt. Failures don't surface in the UI — the
    // value is currently only used by future "most recent" ranking, never
    // for correctness. Intentionally do NOT bump `mutationSequence` (this
    // write is non-authoritative); however we DO refuse to patch local
    // state if the row is no longer present, so a concurrent delete from
    // another tab cannot resurrect a phantom row.
    try {
      await getApiClient().post(`/user-preferences/catchphrases/${encodeURIComponent(id)}/touch`);
      set((state) => {
        if (!state.catchphrases.some((row) => row.id === id)) {
          return state;
        }
        return {
          ...state,
          catchphrases: state.catchphrases.map((row) =>
            row.id === id ? { ...row, lastUsedAt: new Date().toISOString() } : row,
          ),
        };
      });
    } catch {
      // ignore
    }
  },

  applyCatchphrases: (next) => {
    mutationSequence += 1;
    set({
      catchphrases: next,
      hydrated: true,
      error: null,
    });
  },

  reset: () => {
    mutationSequence += 1;
    set({
      catchphrases: [],
      hydrated: false,
      loading: false,
      error: null,
    });
  },
}));

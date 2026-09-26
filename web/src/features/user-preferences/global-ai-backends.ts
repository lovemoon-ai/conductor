import { create } from 'zustand';
import { getApiClient } from '@/shared/api/client';

/** RFC 0041: a daemon's AI backend that any project may run its tasks on. */
export type GlobalAiBackend = { host: string; backend: string };

export const globalAiBackendKey = (entry: GlobalAiBackend): string => `${entry.host}\u0000${entry.backend}`;

export const normalizeGlobalAiBackends = (value: unknown): GlobalAiBackend[] => {
  const list = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>).backends
    : value;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const host = typeof record.host === 'string' ? record.host.trim() : '';
    const backend = typeof record.backend === 'string' ? record.backend.trim().toLowerCase() : '';
    if (!host || !backend) return [];
    const entry = { host, backend };
    const key = globalAiBackendKey(entry);
    if (seen.has(key)) return [];
    seen.add(key);
    return [entry];
  });
};

type GlobalAiBackendsState = {
  backends: GlobalAiBackend[];
  hydrated: boolean;
  saving: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  save: (backends: GlobalAiBackend[]) => Promise<void>;
  apply: (backends: GlobalAiBackend[]) => void;
  reset: () => void;
};

// Bumped by every save/apply so a slower GET cannot overwrite a newer list.
let mutationSequence = 0;

const errorMessage = (error: unknown): string => {
  const payload = (error as { payload?: { error?: unknown } } | null)?.payload;
  if (payload && typeof payload.error === 'string') return payload.error;
  return error instanceof Error ? error.message : 'Failed to save global AI backends';
};

export const useGlobalAiBackendsStore = create<GlobalAiBackendsState>()((set, get) => ({
  backends: [],
  hydrated: false,
  saving: false,
  error: null,

  // `hydrated` stays false on failure: the list is unknown, so editors must not
  // save (a PUT replaces the whole list) and the next mount retries.
  hydrate: async () => {
    const sequenceAtStart = mutationSequence;
    try {
      const response = await getApiClient().get('/user-preferences/global-ai-backends');
      if (mutationSequence !== sequenceAtStart) return;
      set({ backends: normalizeGlobalAiBackends(response), hydrated: true, error: null });
    } catch (error) {
      set({ error: errorMessage(error) });
    }
  },

  save: async (backends) => {
    mutationSequence += 1;
    const previous = get().backends;
    set({ backends, saving: true, error: null });
    try {
      const response = await getApiClient().put('/user-preferences/global-ai-backends', { backends });
      set({ backends: normalizeGlobalAiBackends(response), saving: false });
    } catch (error) {
      set({ backends: previous, saving: false, error: errorMessage(error) });
    }
  },

  apply: (backends) => {
    mutationSequence += 1;
    set({ backends, hydrated: true });
  },

  reset: () => {
    mutationSequence += 1;
    set({ backends: [], hydrated: false, saving: false, error: null });
  },
}));

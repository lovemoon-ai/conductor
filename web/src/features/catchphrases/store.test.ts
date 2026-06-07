import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
}));

vi.mock('@/shared/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...actual,
    getApiClient: () => apiMocks,
  };
});

import { useCatchphrasesStore } from './store';

const sample = (overrides: Partial<{ id: string; text: string; sortOrder: number }> = {}) => ({
  id: overrides.id ?? 'cp-1',
  text: overrides.text ?? 'hello',
  sortOrder: overrides.sortOrder ?? 0,
  lastUsedAt: null,
  createdAt: '2026-06-06T00:00:00Z',
  updatedAt: '2026-06-06T00:00:00Z',
});

describe('useCatchphrasesStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCatchphrasesStore.setState({
      catchphrases: [],
      hydrated: false,
      loading: false,
      error: null,
    });
  });

  it('hydrates from GET /user-preferences/catchphrases', async () => {
    apiMocks.get.mockResolvedValue({ catchphrases: [sample(), sample({ id: 'cp-2', sortOrder: 1 })] });
    await useCatchphrasesStore.getState().hydrate();
    const state = useCatchphrasesStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.loading).toBe(false);
    expect(state.catchphrases).toHaveLength(2);
    // Ordered by sortOrder.
    expect(state.catchphrases[0].id).toBe('cp-1');
    expect(state.catchphrases[1].id).toBe('cp-2');
  });

  it('records an error message when hydrate fails', async () => {
    apiMocks.get.mockRejectedValue(new Error('boom'));
    await useCatchphrasesStore.getState().hydrate();
    const state = useCatchphrasesStore.getState();
    expect(state.hydrated).toBe(false);
    expect(state.error).toBe('boom');
  });

  it('create returns the new row and merges the server snapshot', async () => {
    apiMocks.post.mockResolvedValue({
      catchphrases: [sample({ id: 'cp-1', sortOrder: 0 }), sample({ id: 'cp-new', text: 'new', sortOrder: 1 })],
    });
    const created = await useCatchphrasesStore.getState().create('  new  ');
    expect(apiMocks.post).toHaveBeenCalledWith('/user-preferences/catchphrases', { text: 'new' });
    expect(created?.id).toBe('cp-new');
    expect(useCatchphrasesStore.getState().catchphrases).toHaveLength(2);
  });

  it('create returns null and surfaces an error message on API failure', async () => {
    apiMocks.post.mockRejectedValue(new Error('limit reached'));
    const result = await useCatchphrasesStore.getState().create('text');
    expect(result).toBeNull();
    expect(useCatchphrasesStore.getState().error).toBe('limit reached');
  });

  it('update is optimistic and rolls back on failure', async () => {
    useCatchphrasesStore.setState({ catchphrases: [sample({ id: 'cp-1', text: 'old' })] });
    apiMocks.patch.mockRejectedValue(new Error('server down'));
    const result = await useCatchphrasesStore.getState().update('cp-1', 'new');
    expect(result).toBe(false);
    expect(useCatchphrasesStore.getState().catchphrases[0].text).toBe('old');
    expect(useCatchphrasesStore.getState().error).toBe('server down');
  });

  it('remove is optimistic and rolls back on failure', async () => {
    const row = sample({ id: 'cp-1' });
    useCatchphrasesStore.setState({ catchphrases: [row] });
    apiMocks.delete.mockRejectedValue(new Error('nope'));
    await useCatchphrasesStore.getState().remove('cp-1');
    expect(useCatchphrasesStore.getState().catchphrases).toEqual([row]);
    expect(useCatchphrasesStore.getState().error).toBe('nope');
  });

  it('reorder issues PUT and applies server snapshot', async () => {
    const a = sample({ id: 'a', sortOrder: 0 });
    const b = sample({ id: 'b', sortOrder: 1 });
    useCatchphrasesStore.setState({ catchphrases: [a, b] });
    apiMocks.put.mockResolvedValue({
      catchphrases: [{ ...b, sortOrder: 0 }, { ...a, sortOrder: 1 }],
    });
    await useCatchphrasesStore.getState().reorder(['b', 'a']);
    expect(apiMocks.put).toHaveBeenCalledWith('/user-preferences/catchphrases/reorder', { ids: ['b', 'a'] });
    const state = useCatchphrasesStore.getState();
    expect(state.catchphrases.map((row) => row.id)).toEqual(['b', 'a']);
  });

  it('applyCatchphrases overwrites local state (used by realtime push)', () => {
    useCatchphrasesStore.setState({ catchphrases: [sample()] });
    useCatchphrasesStore.getState().applyCatchphrases([
      sample({ id: 'remote-1' }),
      sample({ id: 'remote-2', sortOrder: 1 }),
    ]);
    const state = useCatchphrasesStore.getState();
    expect(state.catchphrases.map((row) => row.id)).toEqual(['remote-1', 'remote-2']);
    expect(state.hydrated).toBe(true);
  });

  it('out-of-order responses respect the sequence counter (late update is discarded)', async () => {
    // Mount initial state.
    useCatchphrasesStore.setState({
      catchphrases: [sample({ id: 'cp-1', text: 'old' })],
    });

    // Update #1 starts but its response is delayed.
    let resolveSlow: (value: unknown) => void = () => undefined;
    apiMocks.patch
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveSlow = resolve; }),
      )
      .mockResolvedValueOnce({
        catchphrases: [sample({ id: 'cp-1', text: 'second' })],
      });

    const slow = useCatchphrasesStore.getState().update('cp-1', 'first');
    const fast = useCatchphrasesStore.getState().update('cp-1', 'second');
    await fast;

    expect(useCatchphrasesStore.getState().catchphrases[0].text).toBe('second');

    // Now resolve the slow response with an older payload — the sequence
    // guard should ignore it.
    resolveSlow({ catchphrases: [sample({ id: 'cp-1', text: 'first' })] });
    await slow;
    expect(useCatchphrasesStore.getState().catchphrases[0].text).toBe('second');
  });

  it('touch posts to the touch endpoint and updates lastUsedAt locally', async () => {
    useCatchphrasesStore.setState({ catchphrases: [sample({ id: 'cp-1' })] });
    apiMocks.post.mockResolvedValue({});
    await useCatchphrasesStore.getState().touch('cp-1');
    expect(apiMocks.post).toHaveBeenCalledWith('/user-preferences/catchphrases/cp-1/touch');
    expect(useCatchphrasesStore.getState().catchphrases[0].lastUsedAt).not.toBeNull();
  });

  it('touch does not resurrect a row that was removed locally before the response landed', async () => {
    useCatchphrasesStore.setState({ catchphrases: [] });
    apiMocks.post.mockResolvedValue({});
    await useCatchphrasesStore.getState().touch('cp-deleted');
    expect(useCatchphrasesStore.getState().catchphrases).toEqual([]);
  });

  it('reset wipes the library — used by auth.logout to avoid cross-user leak', () => {
    useCatchphrasesStore.setState({
      catchphrases: [sample({ id: 'cp-1' })],
      hydrated: true,
      error: 'previous error',
    });
    useCatchphrasesStore.getState().reset();
    const state = useCatchphrasesStore.getState();
    expect(state.catchphrases).toEqual([]);
    expect(state.hydrated).toBe(false);
    expect(state.error).toBeNull();
  });
});

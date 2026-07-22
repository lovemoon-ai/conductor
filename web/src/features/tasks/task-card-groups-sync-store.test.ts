import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = {
  get: vi.fn(),
  patch: vi.fn(),
};

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => apiMocks,
}));

import { useTaskCardGroupsSyncStore } from './task-card-groups-sync-store';

describe('task-card-groups-sync-store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskCardGroupsSyncStore.getState().reset();
  });

  it('hydrates the server snapshot', async () => {
    apiMocks.get.mockResolvedValue({
      version: 1,
      revision: 2,
      scopes: {
        'projects:p1': [{ id: 'g1', taskIds: ['a', 'b'], labels: { a: 'Design' } }],
      },
    });

    await useTaskCardGroupsSyncStore.getState().hydrate('user-1');

    expect(apiMocks.get).toHaveBeenCalledWith('/user-preferences/task-card-groups');
    expect(useTaskCardGroupsSyncStore.getState()).toMatchObject({
      hydrated: true,
      loading: false,
      error: null,
      snapshot: {
        version: 1,
        revision: 2,
        scopes: {
          'projects:p1': [{ id: 'g1', taskIds: ['a', 'b'], labels: { a: 'Design' } }],
        },
      },
    });
  });

  it('saves only synchronized structure, excluding the device-local active tab', async () => {
    apiMocks.patch.mockResolvedValue({
      version: 1,
      revision: 1,
      scopes: {
        'projects:p1': [{ id: 'g1', taskIds: ['a', 'b'], labels: {} }],
      },
    });

    const saved = await useTaskCardGroupsSyncStore.getState().saveScope('user-1', 'projects:p1', [{
      id: 'g1',
      taskIds: ['a', 'b'],
      activeIndex: 1,
      labels: {},
    }]);

    expect(saved).toBe(true);
    expect(apiMocks.patch).toHaveBeenCalledWith('/user-preferences/task-card-groups', {
      scope: 'projects:p1',
      groups: [{ id: 'g1', taskIds: ['a', 'b'], labels: {} }],
    });
    expect(useTaskCardGroupsSyncStore.getState().snapshot.revision).toBe(1);
  });

  it('ignores an older realtime snapshot', () => {
    const applySnapshot = useTaskCardGroupsSyncStore.getState().applySnapshot;
    applySnapshot({ version: 1, revision: 5, scopes: { 'projects:p1': [] } });
    applySnapshot({
      version: 1,
      revision: 4,
      scopes: {
        'projects:p1': [{ id: 'stale', taskIds: ['a', 'b'], labels: {} }],
      },
    });

    expect(useTaskCardGroupsSyncStore.getState().snapshot).toEqual({
      version: 1,
      revision: 5,
      scopes: { 'projects:p1': [] },
    });
  });

  it('keeps local operation usable when synchronization fails', async () => {
    apiMocks.patch.mockRejectedValue(new Error('offline'));
    await expect(useTaskCardGroupsSyncStore.getState().saveScope('user-1', 'projects:p1', [])).resolves.toBe(false);
    expect(useTaskCardGroupsSyncStore.getState()).toMatchObject({
      hydrated: true,
      error: 'offline',
    });
  });

  it('ignores an old-account save response after logout resets the store', async () => {
    let resolvePatch!: (value: unknown) => void;
    apiMocks.patch.mockReturnValue(new Promise((resolve) => {
      resolvePatch = resolve;
    }));

    const saving = useTaskCardGroupsSyncStore.getState().saveScope('user-1', 'projects:p1', []);
    useTaskCardGroupsSyncStore.getState().reset();
    resolvePatch({ version: 1, revision: 8, scopes: { 'projects:p1': [] } });

    await expect(saving).resolves.toBe(false);
    expect(useTaskCardGroupsSyncStore.getState()).toMatchObject({
      hydrated: false,
      snapshot: { version: 1, revision: 0, scopes: {} },
    });
  });

  it('drops a realtime snapshot belonging to another signed-in user', () => {
    useTaskCardGroupsSyncStore.getState().applySnapshot(
      { version: 1, revision: 2, scopes: { 'projects:p1': [] } },
      'user-1',
    );
    useTaskCardGroupsSyncStore.getState().applySnapshot(
      { version: 1, revision: 9, scopes: { 'projects:p2': [] } },
      'user-2',
    );

    expect(useTaskCardGroupsSyncStore.getState()).toMatchObject({
      ownerUserId: 'user-1',
      snapshot: { revision: 2, scopes: { 'projects:p1': [] } },
    });
  });
});

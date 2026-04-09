import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENTS_POLL_INTERVAL_MS, useAgentsStore } from './agents';

const apiGetMock = vi.fn();

vi.mock('@/shared/api/client', () => ({
  ApiRequestError: class MockApiRequestError extends Error {
    status: number;

    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiRequestError';
      this.status = status;
    }
  },
  getApiClient: () => ({
    get: apiGetMock,
  }),
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('agents store polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiGetMock.mockReset();
    useAgentsStore.getState().stopPolling();
    useAgentsStore.setState({
      agents: [],
      isLoading: false,
      error: null,
      errorStatus: null,
    });
  });

  afterEach(() => {
    useAgentsStore.getState().stopPolling();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('refreshes agents in the background without flipping loading state', async () => {
    const initialFetch = createDeferred<Array<{ id: string; host: string }>>();
    apiGetMock.mockReturnValueOnce(initialFetch.promise);

    const firstFetchPromise = useAgentsStore.getState().fetchAgents();
    expect(useAgentsStore.getState().isLoading).toBe(true);

    initialFetch.resolve([{ id: 'agent-1', host: 'daemon-a' }]);
    await firstFetchPromise;

    expect(useAgentsStore.getState()).toMatchObject({
      agents: [{ id: 'agent-1', host: 'daemon-a' }],
      isLoading: false,
      error: null,
      errorStatus: null,
    });

    const silentFetch = createDeferred<Array<{ id: string; host: string }>>();
    apiGetMock.mockReturnValueOnce(silentFetch.promise);

    useAgentsStore.getState().startPolling();
    await vi.advanceTimersByTimeAsync(AGENTS_POLL_INTERVAL_MS);

    expect(apiGetMock).toHaveBeenCalledTimes(2);
    expect(useAgentsStore.getState().isLoading).toBe(false);

    silentFetch.resolve([{ id: 'agent-2', host: 'daemon-b' }]);
    await Promise.resolve();

    expect(useAgentsStore.getState()).toMatchObject({
      agents: [{ id: 'agent-2', host: 'daemon-b' }],
      isLoading: false,
      error: null,
      errorStatus: null,
    });
  });

  it('starts only one polling interval and stops cleanly', async () => {
    apiGetMock.mockResolvedValue([{ id: 'agent-1', host: 'daemon-a' }]);

    useAgentsStore.getState().startPolling();
    useAgentsStore.getState().startPolling();

    await vi.advanceTimersByTimeAsync(AGENTS_POLL_INTERVAL_MS);
    expect(apiGetMock).toHaveBeenCalledTimes(1);

    useAgentsStore.getState().stopPolling();
    await vi.advanceTimersByTimeAsync(AGENTS_POLL_INTERVAL_MS * 2);

    expect(apiGetMock).toHaveBeenCalledTimes(1);
  });
});

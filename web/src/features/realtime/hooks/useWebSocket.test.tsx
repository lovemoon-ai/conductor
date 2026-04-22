import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocket } from './useWebSocket';

const connectMock = vi.fn();
const disconnectMock = vi.fn();
const fetchTasksMock = vi.fn();
const fetchProjectsMock = vi.fn();

let authState: {
  session: { userToken: string } | null;
} = {
  session: { userToken: 'user-token-1' },
};

let websocketState: {
  status: 'connected' | 'connecting' | 'disconnected';
  connect: typeof connectMock;
  disconnect: typeof disconnectMock;
} = {
  status: 'disconnected',
  connect: connectMock,
  disconnect: disconnectMock,
};

let tasksState: {
  currentProjectFilter: string | null;
  fetchTasks: typeof fetchTasksMock;
} = {
  currentProjectFilter: null,
  fetchTasks: fetchTasksMock,
};

let projectsState: {
  fetchProjects: typeof fetchProjectsMock;
} = {
  fetchProjects: fetchProjectsMock,
};

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));

vi.mock('../store', () => ({
  useWebSocketStore: (selector?: (state: typeof websocketState) => unknown) =>
    selector ? selector(websocketState) : websocketState,
}));

vi.mock('@/features/tasks', () => ({
  useTasksStore: Object.assign(
    (selector: (state: typeof tasksState) => unknown) => selector(tasksState),
    {
      getState: () => tasksState,
    },
  ),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

function TestComponent() {
  useWebSocket();
  return null;
}

describe('useWebSocket', () => {
  beforeEach(() => {
    connectMock.mockReset();
    disconnectMock.mockReset();
    fetchTasksMock.mockReset();
    fetchProjectsMock.mockReset();
    authState = {
      session: { userToken: 'user-token-1' },
    };
    websocketState = {
      status: 'disconnected',
      connect: connectMock,
      disconnect: disconnectMock,
    };
    tasksState = {
      currentProjectFilter: null,
      fetchTasks: fetchTasksMock,
    };
    projectsState = {
      fetchProjects: fetchProjectsMock,
    };
  });

  it('refreshes projects whenever the app websocket connects so missed broadcasts are recovered', () => {
    const { rerender } = render(<TestComponent />);

    expect(connectMock).toHaveBeenCalledWith('user-token-1');
    expect(fetchTasksMock).toHaveBeenCalledWith(undefined);
    expect(fetchProjectsMock).not.toHaveBeenCalled();

    websocketState = {
      ...websocketState,
      status: 'connected',
    };
    rerender(<TestComponent />);

    expect(fetchProjectsMock).toHaveBeenCalledTimes(1);

    websocketState = {
      ...websocketState,
      status: 'disconnected',
    };
    rerender(<TestComponent />);

    websocketState = {
      ...websocketState,
      status: 'connected',
    };
    rerender(<TestComponent />);

    expect(fetchProjectsMock).toHaveBeenCalledTimes(2);
  });
});

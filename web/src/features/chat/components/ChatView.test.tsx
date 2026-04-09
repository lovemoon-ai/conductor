import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatView } from './ChatView';

const useChatStoreMock = vi.fn();
const useRuntimeStoreMock = vi.fn();
const useTasksStoreMock = vi.fn();
const useWebSocketStoreMock = vi.fn();

vi.mock('../store', () => ({
  useChatStore: () => useChatStoreMock(),
}));

vi.mock('@/features/realtime', () => ({
  useRuntimeStore: (selector: (state: {
    byTask: Record<string, unknown>;
    clearTask: (taskId: string) => void;
  }) => unknown) => useRuntimeStoreMock(selector),
  useWebSocketStore: (selector: (state: { status: 'connected' | 'connecting' | 'disconnected' }) => unknown) =>
    useWebSocketStoreMock(selector),
}));

vi.mock('@/features/tasks', () => ({
  useTasksStore: (selector: (state: {
    tasks: Array<Record<string, unknown>>;
  }) => unknown) => useTasksStoreMock(selector),
}));

vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { id: string; content: string } }) => (
    <div data-testid={`message-${message.id}`}>{message.content}</div>
  ),
}));

vi.mock('./MessageInput', () => ({
  MessageInput: ({
    onSend,
    sendDisabled,
  }: {
    onSend: (content: string) => void;
    sendDisabled?: boolean;
  }) => (
    <div data-testid="message-input">
      <button type="button" data-testid="send-button" onClick={() => onSend('hello')}>
        mock send
      </button>
      <div data-testid="send-disabled">{String(Boolean(sendDisabled))}</div>
    </div>
  ),
}));

vi.mock('@/components/common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

const fetchMessagesMock = vi.fn().mockResolvedValue(undefined);
const sendMessageMock = vi.fn().mockResolvedValue(undefined);
const clearRuntimeMock = vi.fn();

const makeMessage = (id: string, content = `message-${id}`) => ({
  id,
  taskId: 'task-1',
  role: 'sdk' as const,
  content,
  createdAt: '2026-03-07T12:00:00.000Z',
});

const mockScrollMetrics = (
  element: HTMLDivElement,
  {
    clientHeight,
    scrollHeight,
    scrollTop,
  }: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  },
) => {
  let currentScrollTop = scrollTop;

  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: clientHeight,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: scrollHeight,
  });
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
  });

  return {
    getScrollTop: () => currentScrollTop,
    setScrollTop: (value: number) => {
      currentScrollTop = value;
    },
    setScrollHeight: (value: number) => {
      Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        value,
      });
    },
  };
};

describe('ChatView', () => {
  let chatState: {
    messagesByTask: Record<string, Array<ReturnType<typeof makeMessage>>>;
    historyStateByTask: Record<string, { hasMoreBefore: boolean; oldestMessageId: string | null }>;
    loadingTasks: Set<string>;
    fetchMessages: typeof fetchMessagesMock;
    sendMessage: typeof sendMessageMock;
  };
  let tasksState: {
    tasks: Array<{
      id: string;
      status: string;
    }>;
  };
  let runtimeState: {
    byTask: Record<string, unknown>;
    clearTask: typeof clearRuntimeMock;
  };
  let websocketState: {
    status: 'connected' | 'connecting' | 'disconnected';
  };

  beforeEach(() => {
    sessionStorage.clear();
    fetchMessagesMock.mockClear();
    sendMessageMock.mockClear();
    clearRuntimeMock.mockClear();

    chatState = {
      messagesByTask: {},
      historyStateByTask: {},
      loadingTasks: new Set(),
      fetchMessages: fetchMessagesMock,
      sendMessage: sendMessageMock,
    };
    tasksState = {
      tasks: [
        {
          id: 'task-1',
          status: 'running',
        },
      ],
    };
    runtimeState = {
      byTask: {},
      clearTask: clearRuntimeMock,
    };
    websocketState = {
      status: 'connected',
    };

    useChatStoreMock.mockImplementation(() => chatState);
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));
    useTasksStoreMock.mockImplementation((selector) => selector(tasksState));
    useWebSocketStoreMock.mockImplementation((selector) => selector(websocketState));
  });

  it('restores the saved reading position when reopening a task', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2')] },
    };

    const firstRender = render(<ChatView taskId="task-1" />);
    const firstScrollContainer = firstRender.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    const firstMetrics = mockScrollMetrics(firstScrollContainer, {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 0,
    });

    firstMetrics.setScrollTop(320);
    fireEvent.scroll(firstScrollContainer);
    firstRender.unmount();

    chatState = {
      ...chatState,
      messagesByTask: {},
      loadingTasks: new Set(['task-1']),
    };

    const secondRender = render(<ChatView taskId="task-1" />);
    const secondScrollContainer = secondRender.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    const secondMetrics = mockScrollMetrics(secondScrollContainer, {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 0,
    });

    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2')] },
      loadingTasks: new Set(),
    };
    secondRender.rerender(<ChatView taskId="task-1" />);

    expect(secondMetrics.getScrollTop()).toBe(320);
  });

  it('does not jump to the bottom when new messages arrive while reading older messages', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2')] },
    };

    const view = render(<ChatView taskId="task-1" />);
    const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    const metrics = mockScrollMetrics(scrollContainer, {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 0,
    });

    metrics.setScrollTop(300);
    fireEvent.scroll(scrollContainer);

    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3')] },
    };
    metrics.setScrollHeight(1200);
    view.rerender(<ChatView taskId="task-1" />);

    expect(metrics.getScrollTop()).toBe(300);
  });

  it('restores to the latest message when the saved position was already at the bottom', () => {
    sessionStorage.setItem('conductor-task-scroll:task-1', JSON.stringify({
      scrollTop: 800,
      stickToBottom: true,
    }));

    chatState = {
      ...chatState,
      loadingTasks: new Set(['task-1']),
    };

    const view = render(<ChatView taskId="task-1" />);
    const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    const metrics = mockScrollMetrics(scrollContainer, {
      clientHeight: 200,
      scrollHeight: 1200,
      scrollTop: 0,
    });

    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3')] },
      loadingTasks: new Set(),
    };
    view.rerender(<ChatView taskId="task-1" />);

    expect(metrics.getScrollTop()).toBe(1000);
  });

  it('shows inline warning instead of alert when the session is not ready', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    tasksState = {
      tasks: [
        {
          id: 'task-1',
          status: 'unknown',
        },
      ],
    };
    useTasksStoreMock.mockImplementation((selector) => selector(tasksState));

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(screen.getByText('The session is still starting. You can keep drafting, and send once the task is ready.')).toBeInTheDocument();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-disabled')).toHaveTextContent('true');
  });

  it('shows the simplified status chips row', () => {
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          statusLine: 'Thinking through the plan',
          source: 'codex-app-server',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);

    expect(screen.queryByText('Task status: running')).not.toBeInTheDocument();
    expect(screen.queryByText('Backend: codex')).not.toBeInTheDocument();
    expect(screen.getByText('Thinking through the plan')).toBeInTheDocument();
  });

  it('shows kimi cli wire runtime status in the chat footer', () => {
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          statusLine: 'Kimi is thinking',
          source: 'kimi-cli-wire',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);

    expect(screen.getByText('Kimi is thinking')).toBeInTheDocument();
  });

  it('auto-loads older history when scrolling to the top', async () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('3'), makeMessage('4')] },
      historyStateByTask: {
        'task-1': {
          hasMoreBefore: true,
          oldestMessageId: '3',
        },
      },
    };

    const view = render(<ChatView taskId="task-1" />);
    const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    mockScrollMetrics(scrollContainer, {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 0,
    });

    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(fetchMessagesMock).toHaveBeenCalledWith('task-1', { beforeId: '3' });
    });
    expect(screen.getByText('Scroll to top to load older messages')).toBeInTheDocument();
  });

  it('keeps auto-loading older history until the viewport is filled', async () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('3'), makeMessage('4')] },
      historyStateByTask: {
        'task-1': {
          hasMoreBefore: true,
          oldestMessageId: '3',
        },
      },
    };

    const view = render(<ChatView taskId="task-1" />);
    const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    const metrics = mockScrollMetrics(scrollContainer, {
      clientHeight: 400,
      scrollHeight: 180,
      scrollTop: 0,
    });

    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(fetchMessagesMock).toHaveBeenNthCalledWith(2, 'task-1', { beforeId: '3' });
    });

    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3'), makeMessage('4')] },
      historyStateByTask: {
        'task-1': {
          hasMoreBefore: true,
          oldestMessageId: '1',
        },
      },
      loadingTasks: new Set(),
    };
    metrics.setScrollHeight(260);
    view.rerender(<ChatView taskId="task-1" />);

    await waitFor(() => {
      expect(fetchMessagesMock).toHaveBeenCalledWith('task-1', { beforeId: '1' });
    });

    chatState = {
      ...chatState,
      messagesByTask: {
        'task-1': [
          makeMessage('0'),
          makeMessage('1'),
          makeMessage('2'),
          makeMessage('3'),
          makeMessage('4'),
        ],
      },
      historyStateByTask: {
        'task-1': {
          hasMoreBefore: false,
          oldestMessageId: '0',
        },
      },
      loadingTasks: new Set(),
    };
    metrics.setScrollHeight(620);
    view.rerender(<ChatView taskId="task-1" />);

    expect(fetchMessagesMock).toHaveBeenCalledTimes(3);
  });

  it('force refreshes history after websocket reconnect', async () => {
    websocketState = { status: 'disconnected' };
    useWebSocketStoreMock.mockImplementation((selector) => selector(websocketState));

    const view = render(<ChatView taskId="task-1" />);
    expect(fetchMessagesMock).toHaveBeenCalledWith('task-1');

    fetchMessagesMock.mockClear();
    websocketState = { status: 'connected' };
    useWebSocketStoreMock.mockImplementation((selector) => selector(websocketState));
    view.rerender(<ChatView taskId="task-1" />);

    await waitFor(() => {
      expect(fetchMessagesMock).toHaveBeenCalledWith('task-1', { force: true });
    });
  });
});

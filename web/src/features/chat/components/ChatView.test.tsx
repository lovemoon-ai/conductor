import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatView } from './ChatView';

const useChatStoreMock = vi.fn();
const useRuntimeStoreMock = vi.fn();
const useTasksStoreMock = vi.fn();
const useWebSocketStoreMock = vi.fn();
const apiPostMock = vi.fn().mockResolvedValue({ delivered: true });
const restartTaskMock = vi.fn().mockResolvedValue({
  mode: 'inplace_restart',
  sourceTaskId: 'task-1',
  task: {
    id: 'task-1',
    status: 'running',
    taskType: 'ai_task',
    createdAt: '2026-03-07T12:00:00.000Z',
    updatedAt: '2026-03-07T12:00:01.000Z',
  },
});

vi.mock('../store', () => ({
  useChatStore: () => useChatStoreMock(),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    post: apiPostMock,
  }),
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
    restartTask: typeof restartTaskMock;
  }) => unknown) => useTasksStoreMock(selector),
}));

vi.mock('./MessageBubble', () => ({
  MessageBubble: ({
    message,
    onResend,
    onRestart,
    onInterrupt,
    restartEnabled,
    restartPending,
    interruptEnabled,
    interruptPending,
  }: {
    message: { id: string; content: string };
    onResend?: (content: string) => void;
    onRestart?: () => void;
    onInterrupt?: () => void;
    restartEnabled?: boolean;
    restartPending?: boolean;
    interruptEnabled?: boolean;
    interruptPending?: boolean;
  }) => (
    <div data-testid={`message-${message.id}`}>
      <span>{message.content}</span>
      <button type="button" data-testid={`resend-${message.id}`} onClick={() => onResend?.(message.content)}>
        resend
      </button>
      <button type="button" data-testid={`message-restart-${message.id}`} onClick={() => onRestart?.()}>
        restart message
      </button>
      <button type="button" data-testid={`message-interrupt-${message.id}`} onClick={() => onInterrupt?.()}>
        interrupt message
      </button>
      <div data-testid={`message-restart-enabled-${message.id}`}>{String(Boolean(restartEnabled))}</div>
      <div data-testid={`message-restart-pending-${message.id}`}>{String(Boolean(restartPending))}</div>
      <div data-testid={`message-interrupt-enabled-${message.id}`}>{String(Boolean(interruptEnabled))}</div>
      <div data-testid={`message-interrupt-pending-${message.id}`}>{String(Boolean(interruptPending))}</div>
    </div>
  ),
}));

vi.mock('./MessageInput', async () => {
  const React = await import('react');

  const MockMessageInput = React.forwardRef(function MockMessageInput({
    onSend,
    onInterrupt,
    sendDisabled,
    interruptEnabled,
    interruptPending,
  }: {
    onSend: (content: string) => void;
    onInterrupt?: () => void;
    sendDisabled?: boolean;
    interruptEnabled?: boolean;
    interruptPending?: boolean;
  }, ref: React.ForwardedRef<{ resend: (content: string) => void }>) {
    const [resendRequest, setResendRequest] = React.useState('');

    React.useImperativeHandle(ref, () => ({
      resend: (content: string) => {
        setResendRequest(content);
      },
    }), []);

    return (
      <div data-testid="message-input">
        <button type="button" data-testid="send-button" onClick={() => onSend('hello')}>
          mock send
        </button>
        <button type="button" data-testid="interrupt-button" onClick={() => onInterrupt?.()}>
          mock interrupt
        </button>
        <div data-testid="send-disabled">{String(Boolean(sendDisabled))}</div>
        <div data-testid="interrupt-enabled">{String(Boolean(interruptEnabled))}</div>
        <div data-testid="interrupt-pending">{String(Boolean(interruptPending))}</div>
        <div data-testid="resend-request">{resendRequest}</div>
      </div>
    );
  });

  MockMessageInput.displayName = 'MockMessageInput';

  return { MessageInput: MockMessageInput };
});

vi.mock('@/components/common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

const fetchMessagesMock = vi.fn().mockResolvedValue(undefined);
const sendMessageMock = vi.fn().mockResolvedValue(undefined);
const clearRuntimeMock = vi.fn();

const makeMessage = (id: string, content = `message-${id}`, metadata: Record<string, unknown> | null = null) => ({
  id,
  taskId: 'task-1',
  role: 'sdk' as const,
  content,
  metadata,
  createdAt: '2026-03-07T12:00:00.000Z',
});

type TestMessage = Omit<ReturnType<typeof makeMessage>, 'role'> & {
  role: 'sdk' | 'user';
};

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
    messagesByTask: Record<string, TestMessage[]>;
    historyStateByTask: Record<string, { hasMoreBefore: boolean; oldestMessageId: string | null }>;
    loadingTasks: Set<string>;
    fetchMessages: typeof fetchMessagesMock;
    sendMessage: typeof sendMessageMock;
  };
  let tasksState: {
    tasks: Array<{
      id: string;
      status: string;
      taskType?: string;
    }>;
    restartTask: typeof restartTaskMock;
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
    sendMessageMock.mockResolvedValue(makeMessage('msg-sent-1', 'hello'));
    clearRuntimeMock.mockClear();
    apiPostMock.mockClear();
    apiPostMock.mockResolvedValue({ delivered: true });
    restartTaskMock.mockClear();
    restartTaskMock.mockResolvedValue({
      mode: 'inplace_restart',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-1',
        status: 'running',
        taskType: 'ai_task',
        createdAt: '2026-03-07T12:00:00.000Z',
        updatedAt: '2026-03-07T12:00:01.000Z',
      },
    });

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
          taskType: 'ai_task',
        },
      ],
      restartTask: restartTaskMock,
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
          taskType: 'ai_task',
        },
      ],
      restartTask: restartTaskMock,
    };
    useTasksStoreMock.mockImplementation((selector) => selector(tasksState));

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(screen.getByText('The session is still starting. You can keep drafting, and send once the task is ready.')).toBeInTheDocument();
    });
    expect(alertSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-disabled')).toHaveTextContent('true');
    expect(screen.queryByTestId(/^message-restart-enabled-/)).not.toBeInTheDocument();
  });

  it('routes a message resend action into the composer request', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1', 'repeat this prompt')] },
    };

    render(<ChatView taskId="task-1" />);

    expect(screen.getByTestId('resend-request')).toHaveTextContent('');
    fireEvent.click(screen.getByTestId('resend-1'));

    expect(screen.getByTestId('resend-request')).toHaveTextContent('repeat this prompt');
  });

  it('restarts the current task from the message action sheet path', async () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('msg-user-1', 'restart this task')] },
    };
    useChatStoreMock.mockImplementation(() => chatState);

    render(<ChatView taskId="task-1" />);

    expect(screen.getByTestId('message-restart-enabled-msg-user-1')).toHaveTextContent('true');
    fireEvent.click(screen.getByTestId('message-restart-msg-user-1'));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        restartMode: 'refresh_session',
      });
    });
    await waitFor(() => {
      expect(clearRuntimeMock).toHaveBeenCalledWith('task-1');
    });
  });

  it('shows restart session action in the empty state for a running task', async () => {
    render(<ChatView taskId="task-1" />);

    expect(screen.getByText('No messages yet')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('empty-state-restart'));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        restartMode: 'refresh_session',
      });
    });
  });

  it('disables message restart for non-running tasks', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('msg-user-1', 'restart this task')] },
    };
    tasksState = {
      tasks: [
        {
          id: 'task-1',
          status: 'unknown',
          taskType: 'ai_task',
        },
      ],
      restartTask: restartTaskMock,
    };
    useChatStoreMock.mockImplementation(() => chatState);
    useTasksStoreMock.mockImplementation((selector) => selector(tasksState));

    render(<ChatView taskId="task-1" />);

    expect(screen.getByTestId('message-restart-enabled-msg-user-1')).toHaveTextContent('false');
  });

  it('disables restart while an interrupt request is pending', async () => {
    let resolveInterrupt!: () => void;
    apiPostMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInterrupt = () => {
            resolve({ delivered: true });
          };
        }),
    );
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('msg-user-1', 'restart this task')] },
    };
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useChatStoreMock.mockImplementation(() => chatState);
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);

    fireEvent.click(screen.getByTestId('interrupt-button'));

    await waitFor(() => {
      expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('message-restart-enabled-msg-user-1')).toHaveTextContent('false');

    fireEvent.click(screen.getByTestId('message-restart-msg-user-1'));

    expect(restartTaskMock).not.toHaveBeenCalled();
    expect(screen.getByText('Wait for the current interrupt to finish before restarting the AI session.')).toBeInTheDocument();

    resolveInterrupt();
  });

  it('blocks sends while a restart is already in progress', async () => {
    let resolveRestart!: () => void;
    restartTaskMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestart = () => {
            resolve({
              mode: 'inplace_restart',
              sourceTaskId: 'task-1',
              task: {
                id: 'task-1',
                status: 'running',
                taskType: 'ai_task',
                createdAt: '2026-03-07T12:00:00.000Z',
                updatedAt: '2026-03-07T12:00:01.000Z',
              },
            });
          };
        }),
    );
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('msg-user-1', 'restart this task')] },
    };
    useChatStoreMock.mockImplementation(() => chatState);

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('message-restart-msg-user-1'));

    await waitFor(() => {
      expect(screen.getByTestId('message-restart-pending-msg-user-1')).toHaveTextContent('true');
    });
    expect(screen.getByTestId('send-disabled')).toHaveTextContent('true');
    expect(screen.getByText('Restarting the current AI session…')).toBeInTheDocument();

    resolveRestart();
    await waitFor(() => {
      expect(screen.getByTestId('message-restart-pending-msg-user-1')).toHaveTextContent('false');
    });
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

  it('sends an interrupt request for the current reply target', async () => {
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('interrupt-button'));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/interrupt', {
        target_reply_to: 'msg-user-1',
      });
    });
    expect(screen.getByTestId('interrupt-enabled')).toHaveTextContent('true');
  });

  it('sends an interrupt request from the message action sheet path', async () => {
    chatState = {
      ...chatState,
      messagesByTask: {
        'task-1': [makeMessage('msg-user-1', 'hello', null)],
      },
    };
    useChatStoreMock.mockImplementation(() => chatState);
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);
    expect(screen.getByTestId('message-interrupt-enabled-msg-user-1')).toHaveTextContent('true');
    fireEvent.click(screen.getByTestId('message-interrupt-msg-user-1'));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/interrupt', {
        target_reply_to: 'msg-user-1',
      });
    });
  });

  it('does not enable interrupt from a completed runtime reply target', async () => {
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: false,
          replyTo: 'msg-user-old',
          statusDoneLine: 'codex finished',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);

    expect(screen.getByTestId('interrupt-enabled')).toHaveTextContent('false');
    fireEvent.click(screen.getByTestId('interrupt-button'));

    await waitFor(() => {
      expect(apiPostMock).not.toHaveBeenCalled();
    });
    expect(screen.getByText('The current reply is not ready to interrupt yet. Try again in a moment.')).toBeInTheDocument();
  });

  it('uses the freshly sent message target instead of a stale completed runtime reply target', async () => {
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: false,
          replyTo: 'msg-user-old',
          statusDoneLine: 'codex finished',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));
    sendMessageMock.mockResolvedValue(makeMessage('msg-user-new', 'hello'));

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('task-1', { content: 'hello', role: 'user' });
    });
    expect(screen.getByTestId('interrupt-enabled')).toHaveTextContent('true');

    fireEvent.click(screen.getByTestId('interrupt-button'));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/interrupt', {
        target_reply_to: 'msg-user-new',
      });
    });
  });

  it('enables interrupt immediately after sending a message, before runtime status catches up', async () => {
    sendMessageMock.mockResolvedValue(makeMessage('msg-user-immediate', 'hello'));

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('task-1', { content: 'hello', role: 'user' });
    });
    expect(screen.getByTestId('interrupt-enabled')).toHaveTextContent('true');

    fireEvent.click(screen.getByTestId('interrupt-button'));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/interrupt', {
        target_reply_to: 'msg-user-immediate',
      });
    });
  });

  it('falls back to the last sent user message id when runtime reply target is not ready yet', async () => {
    sendMessageMock.mockResolvedValue(makeMessage('msg-user-fallback', 'hello'));

    render(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('send-button'));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('task-1', { content: 'hello', role: 'user' });
    });

    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    fireEvent.click(screen.getByTestId('interrupt-button'));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/interrupt', {
        target_reply_to: 'msg-user-fallback',
      });
    });
  });

  it('releases the pending interrupt state when no confirmation arrives in time', async () => {
    vi.useFakeTimers();
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('interrupt-button'));
      await Promise.resolve();
    });

    expect(apiPostMock).toHaveBeenCalledWith('/tasks/task-1/interrupt', {
      target_reply_to: 'msg-user-1',
    });
    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('true');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('false');
    expect(screen.getByText('Interrupt request was not confirmed. You can try again.')).toBeInTheDocument();
  });

  it('auto-dismisses the composer feedback notice after 5 seconds', async () => {
    vi.useFakeTimers();
    apiPostMock.mockRejectedValueOnce(new Error('network down'));
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    render(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('interrupt-button'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.getByText('Failed to interrupt the current reply. Please try again in a moment.'),
    ).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(
      screen.queryByText('Failed to interrupt the current reply. Please try again in a moment.'),
    ).not.toBeInTheDocument();
  });

  it('does not auto-dismiss the in-flight "Restarting the current AI session…" notice', async () => {
    vi.useFakeTimers();
    let resolveRestart!: () => void;
    restartTaskMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRestart = () => {
            resolve({
              mode: 'inplace_restart',
              sourceTaskId: 'task-1',
              task: {
                id: 'task-1',
                status: 'running',
                taskType: 'ai_task',
                createdAt: '2026-03-07T12:00:00.000Z',
                updatedAt: '2026-03-07T12:00:01.000Z',
              },
            });
          };
        }),
    );
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('msg-user-1', 'restart this task')] },
    };
    useChatStoreMock.mockImplementation(() => chatState);

    render(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('message-restart-msg-user-1'));
      await Promise.resolve();
    });

    expect(screen.getByText('Restarting the current AI session…')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Still visible because progress notices must not auto-dismiss.
    expect(screen.getByText('Restarting the current AI session…')).toBeInTheDocument();

    await act(async () => {
      resolveRestart();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText('Restarting the current AI session…')).not.toBeInTheDocument();
  });

  it('keeps the pending interrupt target stable and blocks new sends until it settles', async () => {
    vi.useFakeTimers();
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    const view = render(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('interrupt-button'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('true');
    expect(screen.getByTestId('send-disabled')).toHaveTextContent('true');

    await act(async () => {
      fireEvent.click(screen.getByTestId('send-button'));
      await Promise.resolve();
    });

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(screen.getByText('Wait for the current interrupt to finish before sending another message.')).toBeInTheDocument();

    chatState = {
      ...chatState,
      messagesByTask: {
        'task-1': [
          makeMessage('msg-interrupted-1', 'Conversation interrupted', {
            interrupted: true,
            reply_to: 'msg-user-1',
          }),
        ],
      },
    };
    useChatStoreMock.mockImplementation(() => chatState);

    act(() => {
      view.rerender(<ChatView taskId="task-1" />);
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('false');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText('Interrupt request was not confirmed. You can try again.')).not.toBeInTheDocument();
  });

  it('clears pending interrupt state when an interrupt confirmation message arrives before runtime flips', async () => {
    vi.useFakeTimers();
    sendMessageMock.mockResolvedValue(makeMessage('msg-user-immediate', 'hello'));

    const view = render(<ChatView taskId="task-1" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-button'));
      await Promise.resolve();
    });
    expect(sendMessageMock).toHaveBeenCalledWith('task-1', { content: 'hello', role: 'user' });

    await act(async () => {
      fireEvent.click(screen.getByTestId('interrupt-button'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('true');

    chatState = {
      ...chatState,
      messagesByTask: {
        'task-1': [
          makeMessage('msg-user-immediate', 'hello'),
          makeMessage('msg-interrupted-1', 'Conversation interrupted', {
            interrupted: true,
            reply_to: 'msg-user-immediate',
          }),
        ],
      },
    };
    useChatStoreMock.mockImplementation(() => chatState);

    act(() => {
      view.rerender(<ChatView taskId="task-1" />);
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('false');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText('Interrupt request was not confirmed. You can try again.')).not.toBeInTheDocument();
  });

  it('keeps the scroll-to-bottom button hidden when the user is already at the latest message', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3')] },
    };

    const view = render(<ChatView taskId="task-1" />);
    const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    const metrics = mockScrollMetrics(scrollContainer, {
      clientHeight: 200,
      scrollHeight: 1000,
      scrollTop: 800,
    });

    fireEvent.scroll(scrollContainer);

    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument();
    expect(metrics.getScrollTop()).toBe(800);
  });

  it('shows the scroll-to-bottom button after the user scrolls up', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3')] },
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

    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument();
  });

  it('scrolls back to the latest message and hides itself when the button is clicked', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3')] },
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

    const button = screen.getByTestId('scroll-to-bottom');
    fireEvent.click(button);

    expect(metrics.getScrollTop()).toBe(800);
    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument();
  });

  it('does not show the scroll-to-bottom button when content is not overflowing', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2')] },
    };

    const view = render(<ChatView taskId="task-1" />);
    const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
    mockScrollMetrics(scrollContainer, {
      clientHeight: 400,
      scrollHeight: 420,
      scrollTop: 0,
    });

    fireEvent.scroll(scrollContainer);

    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument();
  });

  it('hides the scroll-to-bottom button when switching to a different task', () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('1'), makeMessage('2'), makeMessage('3')] },
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
    expect(screen.getByTestId('scroll-to-bottom')).toBeInTheDocument();

    tasksState = {
      tasks: [
        {
          id: 'task-2',
          status: 'running',
          taskType: 'ai_task',
        },
      ],
      restartTask: restartTaskMock,
    };
    useTasksStoreMock.mockImplementation((selector) => selector(tasksState));
    chatState = {
      ...chatState,
      messagesByTask: {},
      loadingTasks: new Set(['task-2']),
    };
    useChatStoreMock.mockImplementation(() => chatState);
    // Mimic the real DOM of an empty task-2: no overflow, at top.
    // Otherwise the stale mocked metrics would still look scrollable
    // to the useEffect cleanup that fires on taskId change.
    metrics.setScrollTop(0);
    metrics.setScrollHeight(200);

    view.rerender(<ChatView taskId="task-2" />);

    expect(screen.queryByTestId('scroll-to-bottom')).not.toBeInTheDocument();
  });

  it('clears pending interrupt state once runtime confirms the reply has stopped', async () => {
    vi.useFakeTimers();
    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: true,
          replyTo: 'msg-user-1',
          statusLine: 'Thinking',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    const view = render(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('interrupt-button'));
      await Promise.resolve();
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('true');

    runtimeState = {
      byTask: {
        'task-1': {
          replyInProgress: false,
          statusDoneLine: 'response interrupted',
        },
      },
      clearTask: clearRuntimeMock,
    };
    useRuntimeStoreMock.mockImplementation((selector) => selector(runtimeState));

    act(() => {
      view.rerender(<ChatView taskId="task-1" />);
    });

    expect(screen.getByTestId('interrupt-pending')).toHaveTextContent('false');

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText('Interrupt request was not confirmed. You can try again.')).not.toBeInTheDocument();
  });

  describe('quick-jump question nav', () => {
    const makeUserMessage = (id: string, content = `user-${id}`) => ({
      ...makeMessage(id, content),
      role: 'user' as const,
    });

    const getNav = (root: HTMLElement) =>
      root.querySelector('nav[aria-label="Jump to question"]') as HTMLElement | null;

    it('stays hidden on initial render', () => {
      chatState = {
        ...chatState,
        messagesByTask: {
          'task-1': [makeUserMessage('u1'), makeMessage('a1'), makeUserMessage('u2')],
        },
      };

      const view = render(<ChatView taskId="task-1" />);
      const nav = getNav(view.container);
      expect(nav).not.toBeNull();
      expect(nav!.className).toContain('opacity-0');
      expect(nav!.className).toContain('pointer-events-none');
      // Hidden buttons must be out of the tab order so keyboard users don't
      // hit invisible focus stops.
      const firstDot = nav!.querySelector('button') as HTMLButtonElement;
      expect(firstDot.tabIndex).toBe(-1);
    });

    it('becomes visible after the user scrolls upward', () => {
      chatState = {
        ...chatState,
        messagesByTask: {
          'task-1': [makeUserMessage('u1'), makeMessage('a1'), makeUserMessage('u2')],
        },
      };

      const view = render(<ChatView taskId="task-1" />);
      const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
      const metrics = mockScrollMetrics(scrollContainer, {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 0,
      });

      // Settle the direction baseline at the bottom of the conversation
      // (where the user lands after the initial restore), then scroll up.
      metrics.setScrollTop(800);
      fireEvent.scroll(scrollContainer);
      metrics.setScrollTop(500);
      fireEvent.scroll(scrollContainer);

      const nav = getNav(view.container)!;
      expect(nav.className).toContain('opacity-100');
      expect(nav.className).toContain('pointer-events-auto');
      const firstDot = nav.querySelector('button') as HTMLButtonElement;
      expect(firstDot.tabIndex).toBe(0);
    });

    it('hides again after the user scrolls downward', () => {
      chatState = {
        ...chatState,
        messagesByTask: {
          'task-1': [makeUserMessage('u1'), makeMessage('a1'), makeUserMessage('u2')],
        },
      };

      const view = render(<ChatView taskId="task-1" />);
      const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
      const metrics = mockScrollMetrics(scrollContainer, {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 0,
      });

      metrics.setScrollTop(800);
      fireEvent.scroll(scrollContainer);
      metrics.setScrollTop(400);
      fireEvent.scroll(scrollContainer);
      expect(getNav(view.container)!.className).toContain('opacity-100');

      metrics.setScrollTop(700);
      fireEvent.scroll(scrollContainer);
      const nav = getNav(view.container)!;
      expect(nav.className).toContain('opacity-0');
      expect(nav.className).toContain('pointer-events-none');
    });

    it('does not surface the nav when there is at most one user message', () => {
      chatState = {
        ...chatState,
        messagesByTask: {
          'task-1': [makeUserMessage('u1'), makeMessage('a1')],
        },
      };

      const view = render(<ChatView taskId="task-1" />);
      const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
      const metrics = mockScrollMetrics(scrollContainer, {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 0,
      });

      metrics.setScrollTop(800);
      fireEvent.scroll(scrollContainer);
      metrics.setScrollTop(200);
      fireEvent.scroll(scrollContainer);

      // The component still renders a single dot (count > 0) but the
      // visibility flag is gated on `count > 1`, so it must stay hidden
      // regardless of scroll direction.
      const nav = getNav(view.container)!;
      expect(nav.className).toContain('opacity-0');
    });

    it('marks the clicked dot as active and scrolls the container when a jump is requested', () => {
      chatState = {
        ...chatState,
        messagesByTask: {
          'task-1': [
            makeUserMessage('u1'),
            makeUserMessage('u2'),
            makeUserMessage('u3'),
          ],
        },
      };

      const view = render(<ChatView taskId="task-1" />);
      const scrollContainer = view.container.querySelector('.webapp-scrollbar') as HTMLDivElement;
      const metrics = mockScrollMetrics(scrollContainer, {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 0,
      });

      // Reach a state a real user can actually be in: scrolled up far enough
      // that the nav is visible and interactive. Without this, fireEvent
      // would dispatch through a `pointer-events-none` element, which
      // bypasses real-world hit testing and weakens the test.
      metrics.setScrollTop(800);
      fireEvent.scroll(scrollContainer);
      metrics.setScrollTop(400);
      fireEvent.scroll(scrollContainer);

      const nav = view.container.querySelector(
        'nav[aria-label="Jump to question"]',
      ) as HTMLElement;
      expect(nav.className).toContain('opacity-100');
      const dots = nav.querySelectorAll('button');
      expect(dots.length).toBe(3);
      expect((dots[0] as HTMLButtonElement).tabIndex).toBe(0);

      const scrollTopBeforeClick = metrics.getScrollTop();
      fireEvent.click(dots[1] as HTMLElement);

      // Active-dot rendering reflects the click.
      const activeSpan = (dots[1] as HTMLElement).querySelector('span') as HTMLElement;
      expect(activeSpan.className).toContain('h-3');
      expect(activeSpan.className).toContain('w-3');
      const inactiveSpan = (dots[0] as HTMLElement).querySelector('span') as HTMLElement;
      expect(inactiveSpan.className).toContain('h-1.5');
      expect(inactiveSpan.className).toContain('w-1.5');

      // The container also actually scrolled. In jsdom getBoundingClientRect
      // returns zeros, so the jump math collapses to
      //   nextScrollTop = clamp(scrollTopBeforeClick + 0 - QUESTION_JUMP_TOP_PADDING_PX)
      // which is enough to confirm scrollTop moved (and to the expected
      // value), without depending on layout assumptions. The padding
      // constant lives in ChatView.tsx; mirroring its current value here
      // keeps this test independent of that import surface.
      const QUESTION_JUMP_TOP_PADDING_PX = 12;
      expect(metrics.getScrollTop()).toBe(
        scrollTopBeforeClick - QUESTION_JUMP_TOP_PADDING_PX,
      );
    });
  });
});

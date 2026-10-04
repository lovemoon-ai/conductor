import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ChatView } from './ChatView';
import { ChatMenuSlotContext } from '../chat-menu-slot';

// Mounts ChatView under a header slot so its ⋯ menu (restart etc.) renders.
const renderWithChatMenu = (ui: ReactElement) => {
  const slot = document.createElement('div');
  document.body.appendChild(slot);
  return render(<ChatMenuSlotContext.Provider value={slot}>{ui}</ChatMenuSlotContext.Provider>);
};

const useChatStoreMock = vi.fn();
const useRuntimeStoreMock = vi.fn();
const useTasksStoreMock = vi.fn();
const useWebSocketStoreMock = vi.fn();
const useProjectsStoreMock = vi.fn();
const apiPostMock = vi.fn().mockResolvedValue({ delivered: true });
const requestTaskRuntimeStatusMock = vi.fn();
const fetchTaskMock = vi.fn().mockResolvedValue(null);
const fetchProjectsMock = vi.fn().mockResolvedValue(undefined);
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
  useChatStore: (selector: (state: ReturnType<typeof useChatStoreMock>) => unknown) => selector(useChatStoreMock()),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    post: apiPostMock,
  }),
}));

vi.mock('@/features/realtime', () => ({
  requestTaskRuntimeStatus: (taskId: string) => requestTaskRuntimeStatusMock(taskId),
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
    fetchTask: typeof fetchTaskMock;
    restartTask: typeof restartTaskMock;
  }) => unknown) => useTasksStoreMock(selector),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: {
    fetchProjects: typeof fetchProjectsMock;
  }) => unknown) => useProjectsStoreMock(selector),
}));

vi.mock('./MessageBubble', () => ({
  MessageBubble: ({
    message,
    onResend,
  }: {
    message: { id: string; content: string };
    onResend?: (content: string) => void;
  }) => (
    <div data-testid={`message-${message.id}`}>
      <span>{message.content}</span>
      <button type="button" data-testid={`resend-${message.id}`} onClick={() => onResend?.(message.content)}>
        resend
      </button>
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
      getDraft: () => 'draft from composer',
      restoreDraft: () => {},
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

vi.mock('@/features/tasks/components/PersistentTaskDialogs', () => ({
  NewRoundDialog: ({
    open,
    onStartRound,
  }: {
    open: boolean;
    onStartRound: (input: { content: string; backendType?: string }) => Promise<void>;
  }) => (open ? (
    <button type="button" data-testid="new-round-dialog-start" onClick={() => void onStartRound({ content: 'from dialog', backendType: 'codex' })}>
      start
    </button>
  ) : null),
  PersistentTaskSettingsDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="persistent-settings-dialog" /> : null),
}));

vi.mock('./ScheduledMessageDialog', () => ({
  ScheduledMessageDialog: ({ open, message }: { open: boolean; message: { content: string } | null }) => (
    open ? <div data-testid="scheduled-message-dialog">{message?.content}</div> : null
  ),
}));

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
    fetchTask: typeof fetchTaskMock;
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
    requestTaskRuntimeStatusMock.mockClear();
    fetchTaskMock.mockClear();
    fetchTaskMock.mockResolvedValue(null);
    fetchProjectsMock.mockClear();
    fetchProjectsMock.mockResolvedValue(undefined);
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
      fetchTask: fetchTaskMock,
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
    useProjectsStoreMock.mockImplementation((selector) => selector({ fetchProjects: fetchProjectsMock }));
    useWebSocketStoreMock.mockImplementation((selector) => selector(websocketState));
  });

  describe('idle notice on entry', () => {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const useMessages = (...messages: TestMessage[]) => {
      chatState = { ...chatState, messagesByTask: { 'task-1': messages } };
    };

    it('tells the user how long ago a finished conversation last moved', () => {
      useMessages(
        { ...makeMessage('q', 'question'), role: 'user', createdAt: minutesAgo(125) },
        { ...makeMessage('a', 'answer'), createdAt: minutesAgo(120) },
      );

      const view = render(<ChatView taskId="task-1" />);

      expect(screen.getByTestId('chat-idle-notice')).toHaveTextContent('Last message: 2h ago — the prompt cache has likely expired.');

      // The notice is a one-off hint for the entry; it steps aside once the chat moves on.
      useMessages(...chatState.messagesByTask['task-1'], { ...makeMessage('next', 'next'), role: 'user', createdAt: minutesAgo(0) });
      view.rerender(<ChatView taskId="task-1" />);
      expect(screen.queryByTestId('chat-idle-notice')).not.toBeInTheDocument();
    });

    it('waits for the initial load before judging the last message', () => {
      chatState = { ...chatState, loadingTasks: new Set(['task-1']) };
      const view = render(<ChatView taskId="task-1" />);
      expect(screen.queryByTestId('chat-idle-notice')).not.toBeInTheDocument();

      chatState = { ...chatState, loadingTasks: new Set() };
      useMessages({ ...makeMessage('a', 'answer'), createdAt: minutesAgo(30) });
      view.rerender(<ChatView taskId="task-1" />);

      expect(screen.getByTestId('chat-idle-notice')).toHaveTextContent('Last message: 30m ago');
    });

    it('withdraws the notice when the runtime later reports the AI is still mid-turn', () => {
      // Runtime status is not replayed on load, so a long silent tool call can look idle at first.
      useMessages({ ...makeMessage('a', 'Let me run the tests…'), createdAt: minutesAgo(10) });
      const view = render(<ChatView taskId="task-1" />);
      expect(screen.getByTestId('chat-idle-notice')).toBeInTheDocument();

      runtimeState = { ...runtimeState, byTask: { 'task-1': { replyInProgress: true, replyTo: 'q' } } };
      view.rerender(<ChatView taskId="task-1" />);

      expect(screen.queryByTestId('chat-idle-notice')).not.toBeInTheDocument();
    });

    it('stays quiet within five minutes, while the AI still owes a reply, or mid-reply', () => {
      useMessages({ ...makeMessage('a', 'answer'), createdAt: minutesAgo(4) });
      const recent = render(<ChatView taskId="task-1" />);
      expect(screen.queryByTestId('chat-idle-notice')).not.toBeInTheDocument();
      recent.unmount();

      useMessages({ ...makeMessage('q', 'question'), role: 'user', createdAt: minutesAgo(60) });
      const unanswered = render(<ChatView taskId="task-1" />);
      expect(screen.queryByTestId('chat-idle-notice')).not.toBeInTheDocument();
      unanswered.unmount();

      useMessages({ ...makeMessage('a', 'partial answer'), createdAt: minutesAgo(60) });
      runtimeState = { ...runtimeState, byTask: { 'task-1': { replyInProgress: true, replyTo: 'q' } } };
      render(<ChatView taskId="task-1" />);
      expect(screen.queryByTestId('chat-idle-notice')).not.toBeInTheDocument();
    });
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
      fetchTask: fetchTaskMock,
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

  it('restarts the current task from the chat menu', async () => {
    chatState = {
      ...chatState,
      messagesByTask: { 'task-1': [makeMessage('msg-user-1', 'restart this task')] },
    };
    useChatStoreMock.mockImplementation(() => chatState);

    renderWithChatMenu(<ChatView taskId="task-1" />);

    expect(screen.getByTestId('chat-menu-restart')).toBeEnabled();
    fireEvent.click(screen.getByTestId('chat-menu-restart'));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        restartMode: 'refresh_session',
      });
    });
    await waitFor(() => {
      expect(clearRuntimeMock).toHaveBeenCalledWith('task-1');
    });
  });

  it('schedules the composer draft and opens round settings from the chat menu', () => {
    renderWithChatMenu(<ChatView taskId="task-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(screen.getByTestId('scheduled-message-dialog')).toHaveTextContent('draft from composer');

    fireEvent.click(screen.getByRole('button', { name: 'Next round' }));
    expect(screen.getByTestId('persistent-settings-dialog')).toBeInTheDocument();
  });

  it('renders no chat menu when no header slot frames the chat', () => {
    render(<ChatView taskId="task-1" />);

    expect(screen.queryByLabelText('Chat options')).not.toBeInTheDocument();
    expect(screen.queryByTestId('chat-menu-restart')).not.toBeInTheDocument();
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

  it('disables the chat menu restart for non-running tasks', () => {
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
      fetchTask: fetchTaskMock,
      restartTask: restartTaskMock,
    };
    useChatStoreMock.mockImplementation(() => chatState);
    useTasksStoreMock.mockImplementation((selector) => selector(tasksState));

    renderWithChatMenu(<ChatView taskId="task-1" />);

    expect(screen.getByTestId('chat-menu-restart')).toBeDisabled();
    expect(screen.getByTestId('chat-menu-command-stop')).toBeDisabled();
    expect(screen.getByTestId('chat-menu-command-clear')).toBeDisabled();
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

    renderWithChatMenu(<ChatView taskId="task-1" />);
    fireEvent.click(screen.getByTestId('chat-menu-restart'));

    await waitFor(() => {
      expect(screen.getByTestId('chat-menu-restart')).toHaveTextContent('Restarting…');
    });
    expect(screen.getByTestId('chat-menu-restart')).toBeDisabled();
    expect(screen.getByTestId('send-disabled')).toHaveTextContent('true');
    expect(screen.getByText('Restarting the current AI session…')).toBeInTheDocument();

    resolveRestart();
    await waitFor(() => {
      expect(screen.getByTestId('chat-menu-restart')).toHaveTextContent(/^Restart$/);
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

  it('asks the fire to re-report runtime status once the websocket is connected', () => {
    websocketState = { status: 'connecting' };
    useWebSocketStoreMock.mockImplementation((selector) => selector(websocketState));

    const view = render(<ChatView taskId="task-1" />);
    expect(requestTaskRuntimeStatusMock).not.toHaveBeenCalled();

    websocketState = { status: 'connected' };
    useWebSocketStoreMock.mockImplementation((selector) => selector(websocketState));
    view.rerender(<ChatView taskId="task-1" />);

    expect(requestTaskRuntimeStatusMock).toHaveBeenCalledTimes(1);
    expect(requestTaskRuntimeStatusMock).toHaveBeenCalledWith('task-1');
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

    // Interrupt reuses /stop: it sends a `/stop` chat message.
    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('task-1', { content: '/stop', role: 'user' });
    });
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it.each(['/stop', '/clear', '/compact'])('sends %s as a chat message from the chat menu', async (command) => {
    renderWithChatMenu(<ChatView taskId="task-1" />);

    fireEvent.click(screen.getByTestId(`chat-menu-command-${command.slice(1)}`));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith('task-1', { content: command, role: 'user' });
    });
  });

  it('auto-dismisses the composer feedback notice after 5 seconds', async () => {
    vi.useFakeTimers();
    sendMessageMock.mockRejectedValueOnce(new Error('network down'));

    render(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('interrupt-button'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Failed to send the message. Please try again in a moment.')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(screen.queryByText('Failed to send the message. Please try again in a moment.')).not.toBeInTheDocument();
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

    renderWithChatMenu(<ChatView taskId="task-1" />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('chat-menu-restart'));
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
      fetchTask: fetchTaskMock,
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

});

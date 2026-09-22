import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { TaskDetailPane } from './TaskDetailPane';
import { usePtyToggleStore } from '../pty-toggle-store';

const useTasksStoreMock = vi.fn();
const apiGetMock = vi.fn();

vi.mock('../store', () => ({
  useTasksStore: () => useTasksStoreMock(),
  normalizeTask: (task: any) => ({
    id: task.id,
    title: task.title,
    taskType: task.taskType ?? task.task_type ?? 'ai_task',
    status: task.status,
    agentHost: task.agentHost ?? task.agent_host ?? null,
    executionHost: task.executionHost ?? task.execution_host ?? null,
    launchConfig: task.launchConfig ?? task.launch_config ?? null,
    ptySession: task.ptySession ?? task.pty_session ?? null,
    createdAt: task.createdAt ?? task.created_at,
    updatedAt: task.updatedAt ?? task.updated_at ?? null,
  }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: apiGetMock,
  }),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({ title, actions }: { title: string; actions?: ReactNode }) => (
    <div data-testid="header">{title}{actions}</div>
  ),
}));

vi.mock('@/features/chat', async () => {
  const React = await import('react');
  const { createPortal } = await import('react-dom');
  const ChatMenuSlotContext = React.createContext<HTMLElement | null>(null);
  const ChatView = ({
    taskId,
    autoFocusComposer,
  }: {
    taskId: string;
    autoFocusComposer?: boolean;
  }) => {
    const menuSlot = React.useContext(ChatMenuSlotContext);
    return (
      <div data-testid="chat-view" data-chat-viewport="">
        chat:{taskId}:{String(Boolean(autoFocusComposer))}
        <div data-testid="message">
          reply
          <pre data-testid="code-block">wide code</pre>
        </div>
        <div role="dialog" data-testid="message-actions" />
        <div className="message-composer" data-testid="composer" />
        {menuSlot ? createPortal(<button type="button">Chat options</button>, menuSlot) : null}
      </div>
    );
  };
  return { ChatMenuSlotContext, ChatView };
});

vi.mock('@/features/terminal', () => ({
  TerminalView: ({ task }: { task: { id: string; status?: string } }) => (
    <div data-testid="terminal-view">terminal:{task.id}:{task.status}</div>
  ),
}));

vi.mock('@/components/common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

describe('TaskDetailPane', () => {
  const fetchTaskMock = vi.fn();
  const markTaskReadMock = vi.fn();

  beforeEach(() => {
    fetchTaskMock.mockReset();
    markTaskReadMock.mockReset();
    apiGetMock.mockReset();
    window.localStorage.clear();
    usePtyToggleStore.setState({
      byAiTaskId: {},
      hasHydrated: true,
    });
    useTasksStoreMock.mockReturnValue({
      tasks: [],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });
  });

  it('renders immediately from existing task store data while refreshing in background', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-1',
          title: 'Existing task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    render(<TaskDetailPane taskId="task-1" />);

    expect(screen.queryByTestId('loading-spinner')).not.toBeInTheDocument();
    expect(screen.getByTestId('header')).toHaveTextContent('Existing task');
    expect(screen.getByTestId('chat-view')).toHaveTextContent('chat:task-1:false');
    expect(fetchTaskMock).toHaveBeenCalledWith('task-1');
    expect(markTaskReadMock).toHaveBeenCalledWith('task-1');
  });

  it('enables composer autofocus in the desktop split-pane detail usage', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-2',
          title: 'Inline Detail Task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    render(<TaskDetailPane taskId="task-2" hideHeader />);

    expect(screen.getByTestId('chat-view')).toHaveTextContent('chat:task-2:true');
  });

  it('does not show a top scheduled message count for AI tasks', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-scheduled',
          title: 'Scheduled task',
          taskType: 'ai_task',
          status: 'running',
          activeScheduledMessageCount: 2,
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    render(<TaskDetailPane taskId="task-scheduled" />);

    expect(screen.queryByText(/Scheduled messages:/)).toBeNull();
    expect(screen.queryByTestId('task-scheduled-message-count')).toBeNull();
  });

  it('shows a loading spinner when the task is not yet in the store', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));

    render(<TaskDetailPane taskId="task-missing" />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });

  it('renders terminal view for pty tasks without extra worktree details', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-pty',
          title: 'Terminal task',
          taskType: 'pty_task',
          status: 'running',
          launchConfig: {
            worktree: true,
            worktreeBranch: 'abc123',
          },
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    render(<TaskDetailPane taskId="task-pty" />);

    expect(screen.getByTestId('terminal-view')).toHaveTextContent('terminal:task-pty');
    expect(screen.queryByText('worktree')).not.toBeInTheDocument();
    expect(screen.queryByText('abc123')).not.toBeInTheDocument();
  });

  it('keeps a killed AI task on its attached terminal view when the PTY is still alive', async () => {
    fetchTaskMock.mockResolvedValue(null);
    apiGetMock.mockResolvedValue({
      id: 'task-attached-pty',
      title: 'Attached terminal',
      task_type: 'pty_task',
      status: 'running',
      agent_host: 'daemon-a',
      execution_host: 'daemon-a',
      pty_session: { cols: 80, rows: 24 },
      created_at: '2026-03-23T00:00:00.000Z',
      updated_at: null,
    });
    usePtyToggleStore.setState({
      byAiTaskId: { 'task-ai-killed': true },
      hasHydrated: true,
    });
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-ai-killed',
          title: 'Killed AI with live terminal',
          taskType: 'ai_task',
          status: 'killed',
          attachedTerminal: {
            id: 'attached-1',
            ptyTaskId: 'task-attached-pty',
            ptyTaskStatus: 'running',
          },
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    render(<TaskDetailPane taskId="task-ai-killed" />);

    expect(await screen.findByTestId('terminal-view')).toHaveTextContent(
      'terminal:task-attached-pty',
    );
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
    expect(apiGetMock).toHaveBeenCalledWith('/tasks/task-attached-pty');
  });

  it('propagates a PTY init->running status into the locally-hydrated terminal without re-navigation', async () => {
    // The attached PTY task is hydrated once via api.get and kept out of the
    // shared store, so it never sees realtime updates on its own. A PTY is
    // created in `init` and only later flips to `running`. Regression: the
    // stale `init` left TerminalView's refresh disabled and auto-attach
    // suppressed until the user navigated away and back. The fix mirrors the
    // owning AI task's denormalized `attachedTerminal.ptyTaskStatus` into the
    // local snapshot; this test pins that in-place propagation.
    fetchTaskMock.mockResolvedValue(null);
    apiGetMock.mockResolvedValue({
      id: 'task-attached-init',
      title: 'Attached terminal',
      task_type: 'pty_task',
      status: 'init',
      agent_host: 'daemon-a',
      execution_host: 'daemon-a',
      pty_session: { cols: 80, rows: 24 },
      created_at: '2026-03-23T00:00:00.000Z',
      updated_at: null,
    });
    usePtyToggleStore.setState({
      byAiTaskId: { 'task-ai-pty': true },
      hasHydrated: true,
    });

    const aiTaskInit = {
      id: 'task-ai-pty',
      title: 'AI with fresh terminal',
      taskType: 'ai_task',
      status: 'running',
      attachedTerminal: {
        id: 'attached-1',
        ptyTaskId: 'task-attached-init',
        ptyTaskStatus: 'init',
      },
      createdAt: '2026-03-23T00:00:00.000Z',
    };
    useTasksStoreMock.mockReturnValue({
      tasks: [aiTaskInit],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    const view = render(<TaskDetailPane taskId="task-ai-pty" />);

    // Initial hydration: the PTY snapshot carries the stale `init` status.
    expect(await screen.findByTestId('terminal-view')).toHaveTextContent(
      'terminal:task-attached-init:init',
    );

    // Realtime `task_status_update` for the PTY refreshes the owning AI task's
    // denormalized status; re-render the store with the fresh value.
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          ...aiTaskInit,
          attachedTerminal: {
            ...aiTaskInit.attachedTerminal,
            ptyTaskStatus: 'running',
          },
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });
    view.rerender(<TaskDetailPane taskId="task-ai-pty" />);

    await waitFor(() =>
      expect(screen.getByTestId('terminal-view')).toHaveTextContent(
        'terminal:task-attached-init:running',
      ),
    );
  });

  it('switches tasks when the messages or the composer are swiped, like the title', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [{ id: 'task-3', title: 'Swipe Task', taskType: 'ai_task', status: 'running', createdAt: '2026-03-23T00:00:00.000Z' }],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });
    const onSwipeLeft = vi.fn();
    const onSwipeRight = vi.fn();
    const onProgress = vi.fn();
    render(
      <TaskDetailPane
        taskId="task-3"
        onTitleSwipeLeft={onSwipeLeft}
        onTitleSwipeRight={onSwipeRight}
        onTitleSwipeProgress={onProgress}
      />,
    );
    const touchAt = (clientX: number) => ({ pointerId: 1, pointerType: 'touch', clientX, clientY: 100 });
    const swipe = (element: Element, fromX: number, toX: number) => {
      fireEvent.pointerDown(element, touchAt(fromX));
      fireEvent.pointerMove(element, touchAt((fromX + toX) / 2));
      fireEvent.pointerUp(element, touchAt(toX));
    };

    // Sideways-scrolling content and the message action sheet keep the gesture.
    swipe(screen.getByTestId('code-block'), 200, 100);
    swipe(screen.getByTestId('message-actions'), 200, 100);
    expect(onProgress).not.toHaveBeenCalled();
    expect(onSwipeLeft).not.toHaveBeenCalled();

    swipe(screen.getByTestId('message'), 200, 100);
    expect(onSwipeLeft).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ direction: 'left', isDragging: true }));

    const composer = screen.getByTestId('composer');
    swipe(composer, 200, 100);
    expect(onSwipeLeft).toHaveBeenCalledTimes(2);

    swipe(composer, 100, 200);
    expect(onSwipeRight).toHaveBeenCalledTimes(1);
  });

  it('renders the chat menu into its own header, or the surrounding one when headerless', async () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [{ id: 'task-4', title: 'Menu Task', taskType: 'ai_task', status: 'running', createdAt: '2026-03-23T00:00:00.000Z' }],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });
    const view = render(<TaskDetailPane taskId="task-4" />);
    await waitFor(() => {
      expect(within(screen.getByTestId('header')).getByRole('button', { name: 'Chat options' })).toBeInTheDocument();
    });
    view.unmount();

    const outerSlot = document.createElement('div');
    document.body.appendChild(outerSlot);
    const { ChatMenuSlotContext } = await import('@/features/chat');
    render(
      <ChatMenuSlotContext.Provider value={outerSlot}>
        <TaskDetailPane taskId="task-4" hideHeader />
      </ChatMenuSlotContext.Provider>,
    );
    expect(within(outerSlot).getByRole('button', { name: 'Chat options' })).toBeInTheDocument();
    outerSlot.remove();
  });
});

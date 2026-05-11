import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { TaskDetailPane } from './TaskDetailPane';

const useTasksStoreMock = vi.fn();
const useTerminalStoreMock = vi.fn((selector: (state: any) => unknown) => selector({ byTask: {} }));

vi.mock('../store', () => ({
  useTasksStore: () => useTasksStoreMock(),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    actions,
  }: {
    title: string;
    actions?: React.ReactNode;
  }) => (
    <div data-testid="header">
      {title}
      {actions ? <span data-testid="header-actions">{actions}</span> : null}
    </div>
  ),
}));

vi.mock('@/features/chat', () => ({
  ChatView: ({
    taskId,
    autoFocusComposer,
  }: {
    taskId: string;
    autoFocusComposer?: boolean;
  }) => <div data-testid="chat-view">chat:{taskId}:{String(Boolean(autoFocusComposer))}</div>,
}));

vi.mock('@/features/terminal', () => ({
  TerminalView: ({ task }: { task: { id: string } }) => <div data-testid="terminal-view">terminal:{task.id}</div>,
  useTerminalStore: (selector: (state: any) => unknown) => useTerminalStoreMock(selector),
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
    useTerminalStoreMock.mockReset();
    useTerminalStoreMock.mockImplementation((selector: (state: any) => unknown) => selector({ byTask: {} }));
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

  it('shows a loading spinner when the task is not yet in the store', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));

    render(<TaskDetailPane taskId="task-missing" />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });

  it('toggles between chat and terminal views mutually exclusively for ai tasks', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-ai',
          title: 'AI task',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    // Ensure no view-mode persisted from prior tests so default is 'chat'.
    window.sessionStorage.clear();

    render(<TaskDetailPane taskId="task-ai" />);

    // Default: chat view mounted, terminal not mounted.
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();

    // Switch to terminal — chat must unmount (mutual exclusion prevents
    // duplicate writers on the same AI session).
    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();

    // Switch back to chat — terminal must unmount.
    fireEvent.click(screen.getByRole('tab', { name: /chat/i }));
    expect(screen.getByTestId('chat-view')).toBeInTheDocument();
    expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();
  });

  it('locks AI task terminal mode after the terminal session starts', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-ai-locked',
          title: 'AI task terminal locked',
          taskType: 'ai_task',
          status: 'running',
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });
    useTerminalStoreMock.mockImplementation((selector: (state: any) => unknown) =>
      selector({
        byTask: {
          'task-ai-locked': {
            connectionState: 'open',
          },
        },
      }),
    );

    window.sessionStorage.setItem('conductor:ai-task-view:task-ai-locked', 'terminal');

    render(<TaskDetailPane taskId="task-ai-locked" />);

    const chatTab = screen.getByRole('tab', { name: /chat/i });
    expect(chatTab).toBeDisabled();
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();

    fireEvent.click(chatTab);
    expect(screen.getByTestId('terminal-view')).toBeInTheDocument();
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });

  it('treats legacy tasks without taskType as ai tasks', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-legacy-ai',
          title: 'Legacy AI task',
          status: 'running',
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    window.sessionStorage.clear();

    render(<TaskDetailPane taskId="task-legacy-ai" />);

    expect(screen.getByTestId('chat-view')).toHaveTextContent('chat:task-legacy-ai:false');
    expect(screen.queryByTestId('terminal-view')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /chat/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /terminal/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    expect(screen.getByTestId('terminal-view')).toHaveTextContent('terminal:task-legacy-ai');
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument();
  });

  it('does not show the chat/terminal toggle for pty tasks', () => {
    fetchTaskMock.mockReturnValue(new Promise(() => {}));
    useTasksStoreMock.mockReturnValue({
      tasks: [
        {
          id: 'task-pty-only',
          title: 'PTY only task',
          taskType: 'pty_task',
          status: 'running',
          createdAt: '2026-03-23T00:00:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    });

    render(<TaskDetailPane taskId="task-pty-only" />);

    expect(screen.queryByRole('tab', { name: /terminal/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /chat/i })).not.toBeInTheDocument();
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
});

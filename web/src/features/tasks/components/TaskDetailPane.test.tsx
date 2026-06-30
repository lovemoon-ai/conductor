import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
  Header: ({ title }: { title: string }) => <div data-testid="header">{title}</div>,
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
});

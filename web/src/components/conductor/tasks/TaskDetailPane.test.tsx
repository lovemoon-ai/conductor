import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskDetailPane } from './TaskDetailPane';

const useTasksStoreMock = vi.fn();

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: () => useTasksStoreMock(),
}));

vi.mock('@/components/conductor/layout/Header', () => ({
  Header: ({ title }: { title: string }) => <div data-testid="header">{title}</div>,
}));

vi.mock('@/components/conductor/chat/ChatView', () => ({
  ChatView: ({
    taskId,
    autoFocusComposer,
  }: {
    taskId: string;
    autoFocusComposer?: boolean;
  }) => <div data-testid="chat-view">chat:{taskId}:{String(Boolean(autoFocusComposer))}</div>,
}));

vi.mock('@/components/conductor/terminal/TerminalView', () => ({
  TerminalView: ({ task }: { task: { id: string } }) => <div data-testid="terminal-view">terminal:{task.id}</div>,
}));

vi.mock('@/components/conductor/common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

describe('TaskDetailPane', () => {
  const fetchTaskMock = vi.fn();
  const markTaskReadMock = vi.fn();

  beforeEach(() => {
    fetchTaskMock.mockReset();
    markTaskReadMock.mockReset();
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
});

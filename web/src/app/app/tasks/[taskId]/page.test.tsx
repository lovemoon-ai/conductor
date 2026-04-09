import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TaskDetailPage from './page';

const pushMock = vi.fn();
const fetchTaskMock = vi.fn();
const markTaskReadMock = vi.fn();
const headerMock = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => ({ taskId: 'task-pty-1' }),
  useRouter: () => ({ push: pushMock }),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    showConnectionStatus,
  }: {
    title: string;
    showConnectionStatus?: boolean;
  }) => {
    headerMock({ title, showConnectionStatus });
    return <div>{title}</div>;
  },
}));

vi.mock('@/features/chat', () => ({
  ChatView: ({ taskId }: { taskId: string }) => <div>chat:{taskId}</div>,
}));

vi.mock('@/features/terminal', () => ({
  TerminalView: ({ task }: { task: { id: string } }) => <div>terminal:{task.id}</div>,
}));

vi.mock('@/components/common/LoadingSpinner', () => ({
  LoadingSpinner: ({ children }: { children?: ReactNode }) => <div>{children ?? 'loading'}</div>,
}));

vi.mock('@/features/tasks', async () => {
  const actual = await vi.importActual<typeof import('@/features/tasks')>('@/features/tasks');
  return {
    ...actual,
    RestartTaskControls: () => null,
  };
});

vi.mock('@/features/tasks/store', () => ({
  useTasksStore: (selector?: (state: {
    tasks: Array<{
      id: string;
      title: string;
      taskType: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>;
    fetchTask: typeof fetchTaskMock;
    markTaskRead: typeof markTaskReadMock;
  }) => unknown) => {
    const state = {
      tasks: [
        {
          id: 'task-pty-1',
          title: 'Persisted PTY',
          taskType: 'pty_task',
          status: 'killed',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:05:00.000Z',
        },
      ],
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    };

    return typeof selector === 'function' ? selector(state) : state;
  },
}));

describe('TaskDetailPage', () => {
  beforeEach(() => {
    fetchTaskMock.mockReset();
    markTaskReadMock.mockReset();
    pushMock.mockReset();
    headerMock.mockReset();
    fetchTaskMock.mockResolvedValue(null);
  });

  it('fetches task detail on mount and renders terminal view for pty tasks', async () => {
    render(<TaskDetailPage />);

    await waitFor(() => {
      expect(fetchTaskMock).toHaveBeenCalledWith('task-pty-1');
    });
    expect(markTaskReadMock).toHaveBeenCalledWith('task-pty-1');
    expect(await screen.findByText('terminal:task-pty-1')).toBeInTheDocument();
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Persisted PTY',
        showConnectionStatus: true,
      }),
    );
  });
});

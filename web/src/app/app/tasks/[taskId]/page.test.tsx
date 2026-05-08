import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    showBack,
    onBack,
    showConnectionStatus,
  }: {
    title: string;
    showBack?: boolean;
    onBack?: () => void;
    showConnectionStatus?: boolean;
  }) => {
    headerMock({ title, showBack, showConnectionStatus });
    return (
      <div>
        {showBack ? (
          <button type="button" onClick={onBack}>
            back
          </button>
        ) : null}
        <div>{title}</div>
      </div>
    );
  },
}));

vi.mock('@/features/chat', () => ({
  ChatView: ({ taskId }: { taskId: string }) => <div>chat:{taskId}</div>,
}));

vi.mock('@/features/terminal', () => ({
  TerminalView: ({ task }: { task: { id: string } }) => <div>terminal:{task.id}</div>,
  useTerminalStore: (selector: (state: { byTask: Record<string, unknown> }) => unknown) =>
    selector({ byTask: {} }),
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
      projectId?: string | null;
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
          projectId: 'project-1',
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

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: { selectedProjectId: string | null }) => unknown) =>
    selector({ selectedProjectId: 'selected-project' }),
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
        showBack: true,
        showConnectionStatus: true,
      }),
    );
  });

  it('navigates back to the task list scoped to the task project', async () => {
    render(<TaskDetailPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'back' }));

    expect(pushMock).toHaveBeenCalledWith('/app/tasks?projectId=project-1');
  });
});

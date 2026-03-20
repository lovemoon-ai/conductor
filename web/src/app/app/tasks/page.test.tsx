import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TasksPage from './page';

const setProjectFilterMock = vi.fn();
const fetchTasksMock = vi.fn();

let tasksState: {
  setProjectFilter: typeof setProjectFilterMock;
  fetchTasks: typeof fetchTasksMock;
  isLoading: boolean;
  currentProjectFilter: string | null;
  tasks: Array<{ id: string }>;
};

vi.mock('next/navigation', () => ({
  useSearchParams: () => ({
    get: () => null,
  }),
}));

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: (selector: (state: typeof tasksState) => unknown) => selector(tasksState),
}));

vi.mock('@/lib/conductor/stores/projects', () => ({
  useProjectsStore: (selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown) =>
    selector({ projects: [] }),
}));

vi.mock('@/components/conductor/layout/Header', () => ({
  Header: ({ title, actions }: { title?: string; actions?: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      <div>{actions}</div>
    </div>
  ),
}));

const readStoredTaskListViewModeMock = vi.fn(() => 'list');

vi.mock('@/components/conductor/tasks/TaskList', async () => {
  const React = await import('react');
  return {
    TASK_LIST_VIEW_STORAGE_KEY: 'conductor-task-list-view',
    readStoredTaskListViewMode: () => readStoredTaskListViewModeMock(),
    ListIcon: () => <span data-testid="list-icon" />,
    GridIcon: () => <span data-testid="grid-icon" />,
    RefreshIcon: ({ spinning = false }: { spinning?: boolean }) => <span>{spinning ? 'spinning' : 'refresh'}</span>,
    TaskList: ({ viewMode }: { viewMode: string }) => <div>task-list:{viewMode}</div>,
  };
});

vi.mock('@/components/conductor/tasks/CreateTaskDialog', () => ({
  CreateTaskDialog: ({ open }: { open: boolean }) => open ? <div>create-dialog</div> : null,
}));

describe('TasksPage', () => {
  beforeEach(() => {
    localStorage.clear();
    readStoredTaskListViewModeMock.mockReset();
    readStoredTaskListViewModeMock.mockReturnValue('list');
    setProjectFilterMock.mockReset();
    fetchTasksMock.mockReset();

    tasksState = {
      setProjectFilter: setProjectFilterMock,
      fetchTasks: fetchTasksMock,
      isLoading: false,
      currentProjectFilter: 'project-1',
      tasks: [{ id: 'task-1' }],
    };
  });

  it('renders header controls and updates the controlled task list view', () => {
    render(<TasksPage />);

    expect(screen.getByText('Task 1')).toBeInTheDocument();
    const taskList = screen.getByText('task-list:list');
    expect(taskList).toBeInTheDocument();
    expect(taskList.parentElement).toHaveClass('px-4', 'pb-4', 'pt-4');

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));

    expect(screen.getByText('task-list:grid')).toBeInTheDocument();
    expect(localStorage.getItem('conductor-task-list-view')).toBe('grid');
  });

  it('refreshes tasks from the title bar controls', () => {
    render(<TasksPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));

    expect(fetchTasksMock).toHaveBeenCalledWith('project-1', { recoverStale: true });
  });

  it('hydrates the initial view mode from persisted storage before interaction', () => {
    readStoredTaskListViewModeMock.mockReturnValue('grid');

    render(<TasksPage />);

    expect(screen.getByText('task-list:grid')).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskList } from './TaskList';

const deleteTaskMock = vi.fn();
const taskItemMock = vi.fn();

let tasksState: {
  tasks: Array<{ id: string; title: string; projectId: string | null }>;
  isLoading: boolean;
  unreadTaskIds: Set<string>;
  currentProjectFilter: string | null;
  deleteTask: typeof deleteTaskMock;
};

vi.mock('../store', () => ({
  useTasksStore: (selector?: (state: typeof tasksState) => unknown) =>
    typeof selector === 'function' ? selector(tasksState) : tasksState,
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown) =>
    selector({
      projects: [
        { id: 'project-1', name: 'Project One' },
      ],
    }),
}));

vi.mock('./TaskItem', () => ({
  TaskItem: (props: {
    task: { id: string; title: string; projectId: string | null };
    viewMode?: string;
    isActive?: boolean;
  }) => {
    taskItemMock(props);
    return (
      <div data-testid={`task-item-${props.task.id}`}>
        {props.task.title}:{props.viewMode}:{props.isActive ? 'active' : 'idle'}
      </div>
    );
  },
}));

vi.mock('@/components/common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

describe('TaskList', () => {
  beforeEach(() => {
    deleteTaskMock.mockReset();
    taskItemMock.mockReset();

    tasksState = {
      tasks: [
        { id: 'task-1', title: 'Task One', projectId: 'project-1' },
        { id: 'task-2', title: 'Task Two', projectId: 'project-2' },
      ],
      isLoading: false,
      unreadTaskIds: new Set(['task-2']),
      currentProjectFilter: 'project-1',
      deleteTask: deleteTaskMock,
    };
  });

  it('renders list view badges and items', async () => {
    render(<TaskList viewMode="list" activeTaskId="task-2" />);

    expect(await screen.findByText('Task One:list:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:list:active')).not.toBeInTheDocument();
    expect(screen.queryByText('1 unread')).not.toBeInTheDocument();
    expect(screen.queryByText('Project One')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grid view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh tasks' })).toBeNull();
  });

  it('renders grid view when controlled by parent', async () => {
    const { container } = render(<TaskList viewMode="grid" />);

    expect(await screen.findByText('Task One:grid:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:grid:idle')).not.toBeInTheDocument();
    expect(screen.queryByText('1 unread')).not.toBeInTheDocument();
    expect(container.querySelector('[data-task-item-wrapper="task-1"]')).toHaveClass('min-w-0');
  });

  it('shows loading spinner when loading the initial task set', () => {
    tasksState = {
      ...tasksState,
      tasks: [],
      isLoading: true,
    };

    render(<TaskList viewMode="list" />);

    expect(screen.getByTestId('loading-spinner')).toBeInTheDocument();
  });
});

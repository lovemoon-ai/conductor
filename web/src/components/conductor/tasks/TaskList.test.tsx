import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskList } from './TaskList';

const deleteTaskMock = vi.fn();
const taskItemMock = vi.fn();

let tasksState: {
  tasks: Array<{ id: string; title: string }>;
  isLoading: boolean;
  unreadTaskIds: Set<string>;
  currentProjectFilter: string | null;
  deleteTask: typeof deleteTaskMock;
};

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: (selector?: (state: typeof tasksState) => unknown) =>
    typeof selector === 'function' ? selector(tasksState) : tasksState,
}));

vi.mock('@/lib/conductor/stores/projects', () => ({
  useProjectsStore: (selector: (state: { projects: Array<{ id: string; name: string }> }) => unknown) =>
    selector({
      projects: [
        { id: 'project-1', name: 'Project One' },
      ],
    }),
}));

vi.mock('./TaskItem', () => ({
  TaskItem: (props: { task: { id: string; title: string }; viewMode?: string }) => {
    taskItemMock(props);
    return <div data-testid={`task-item-${props.task.id}`}>{props.task.title}:{props.viewMode}</div>;
  },
}));

vi.mock('../common/LoadingSpinner', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
}));

describe('TaskList', () => {
  beforeEach(() => {
    deleteTaskMock.mockReset();
    taskItemMock.mockReset();

    tasksState = {
      tasks: [
        { id: 'task-1', title: 'Task One' },
        { id: 'task-2', title: 'Task Two' },
      ],
      isLoading: false,
      unreadTaskIds: new Set(['task-2']),
      currentProjectFilter: 'project-1',
      deleteTask: deleteTaskMock,
    };
  });

  it('renders list view badges and items', async () => {
    render(<TaskList viewMode="list" />);

    expect(await screen.findByText('Task One:list')).toBeInTheDocument();
    expect(screen.getByText('Task Two:list')).toBeInTheDocument();
    expect(screen.queryByText('1 unread')).not.toBeInTheDocument();
    expect(screen.getByText('Project One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grid view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh tasks' })).toBeNull();
  });

  it('renders grid view when controlled by parent', async () => {
    render(<TaskList viewMode="grid" />);

    expect(await screen.findByText('Task One:grid')).toBeInTheDocument();
    expect(screen.getByText('Task Two:grid')).toBeInTheDocument();
    expect(screen.queryByText('1 unread')).not.toBeInTheDocument();
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

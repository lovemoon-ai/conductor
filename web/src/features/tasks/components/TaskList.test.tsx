import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskList } from './TaskList';

const deleteTaskMock = vi.fn();
const taskItemMock = vi.fn();

let tasksState: {
  tasks: Array<{ id: string; title: string; projectId: string | null; status: string }>;
  isLoading: boolean;
  unreadTaskIds: Set<string>;
  currentProjectFilter: string | null;
  deleteTask: typeof deleteTaskMock;
};
let projectsState: {
  projects: Array<{ id: string; name: string }>;
  hiddenProjectIds: string[];
};

vi.mock('../store', () => ({
  useTasksStore: (selector?: (state: typeof tasksState) => unknown) =>
    typeof selector === 'function' ? selector(tasksState) : tasksState,
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

vi.mock('./TaskItem', () => ({
  TaskItem: (props: {
    task: { id: string; title: string; projectId: string | null; status: string };
    isActive?: boolean;
  }) => {
    taskItemMock(props);
    return (
      <div data-testid={`task-item-${props.task.id}`}>
        {props.task.title}:{props.isActive ? 'active' : 'idle'}
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
        { id: 'task-1', title: 'Task One', projectId: 'project-1', status: 'running' },
        { id: 'task-2', title: 'Task Two', projectId: 'project-2', status: 'completed' },
      ],
      isLoading: false,
      unreadTaskIds: new Set(['task-2']),
      currentProjectFilter: 'project-1',
      deleteTask: deleteTaskMock,
    };
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One' },
      ],
      hiddenProjectIds: [],
    };
  });

  it('renders list view badges and items', async () => {
    render(<TaskList viewMode="list" activeTaskId="task-2" />);

    expect(await screen.findByText('Task One:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:active')).not.toBeInTheDocument();
    expect(screen.queryByText('1 unread')).not.toBeInTheDocument();
    expect(screen.queryByText('Project One')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'List view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Grid view' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refresh tasks' })).toBeNull();
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

  it('excludes hidden project tasks from all-project lists', () => {
    tasksState = {
      ...tasksState,
      currentProjectFilter: null,
    };
    projectsState = {
      ...projectsState,
      hiddenProjectIds: ['project-2'],
    };

    render(<TaskList viewMode="list" />);

    expect(screen.getByText('Task One:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:idle')).toBeNull();
  });

  it('hides non-running tasks when runningOnly is enabled', () => {
    tasksState = {
      ...tasksState,
      currentProjectFilter: null,
    };

    render(<TaskList viewMode="list" runningOnly />);

    expect(screen.getByText('Task One:idle')).toBeInTheDocument();
    expect(screen.queryByText('Task Two:idle')).toBeNull();
  });
});

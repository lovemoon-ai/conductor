import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TasksPage from './page';

const setProjectFilterMock = vi.fn();
const fetchTasksMock = vi.fn();
const replaceMock = vi.fn();
const headerMock = vi.fn();

let tasksState: {
  setProjectFilter: typeof setProjectFilterMock;
  fetchTasks: typeof fetchTasksMock;
  isLoading: boolean;
  currentProjectFilter: string | null;
  tasks: Array<{ id: string }>;
};
let searchParamsState = new URLSearchParams();
let isDesktopViewport = false;

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
  useSearchParams: () => ({
    get: (key: string) => searchParamsState.get(key),
    toString: () => searchParamsState.toString(),
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
  Header: ({
    title,
    actions,
    showConnectionStatus,
    connectionTaskId,
  }: {
    title?: string;
    actions?: React.ReactNode;
    showConnectionStatus?: boolean;
    connectionTaskId?: string | null;
  }) => {
    headerMock({ title, showConnectionStatus, connectionTaskId });
    return (
      <div>
        <h1>{title}</h1>
        <div>{actions}</div>
      </div>
    );
  },
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
    TaskList: ({
      viewMode,
      activeTaskId,
      onOpenTask,
    }: {
      viewMode: string;
      activeTaskId?: string | null;
      onOpenTask?: (taskId: string) => void;
    }) => (
      <>
        <div>task-list:{viewMode}:{activeTaskId ?? 'none'}:{onOpenTask ? 'inline' : 'route'}</div>
        <button type="button" onClick={() => onOpenTask?.('task-2')}>
          select-task-2
        </button>
      </>
    ),
  };
});

vi.mock('@/components/conductor/tasks/CreateTaskDialog', () => ({
  CreateTaskDialog: ({
    open,
    onClose,
    onCreatedTask,
  }: {
    open: boolean;
    onClose: () => void;
    onCreatedTask?: (taskId: string) => void;
  }) => open ? (
    <div>
      <div>create-dialog</div>
      <button type="button" onClick={() => onCreatedTask?.('task-3')}>
        mock-create-success
      </button>
      <button type="button" onClick={onClose}>
        mock-close-create
      </button>
    </div>
  ) : null,
}));

vi.mock('@/components/conductor/tasks/TaskDetailPane', () => ({
  TaskDetailPane: ({ taskId, hideHeader }: { taskId: string; hideHeader?: boolean }) => (
    <div>task-detail:{taskId}:{hideHeader ? 'no-header' : 'header'}</div>
  ),
}));

describe('TasksPage', () => {
  beforeEach(() => {
    localStorage.clear();
    searchParamsState = new URLSearchParams();
    isDesktopViewport = false;
    readStoredTaskListViewModeMock.mockReset();
    readStoredTaskListViewModeMock.mockReturnValue('list');
    setProjectFilterMock.mockReset();
    fetchTasksMock.mockReset();
    replaceMock.mockReset();
    headerMock.mockReset();

    tasksState = {
      setProjectFilter: setProjectFilterMock,
      fetchTasks: fetchTasksMock,
      isLoading: false,
      currentProjectFilter: 'project-1',
      tasks: [{ id: 'task-1' }, { id: 'task-2' }],
    };

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: isDesktopViewport,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('renders header controls and updates the controlled task list view', () => {
    render(<TasksPage />);

    expect(screen.getByText('Task 2')).toBeInTheDocument();
    const taskList = screen.getByText('task-list:list:none:route');
    expect(taskList).toBeInTheDocument();
    expect(taskList.parentElement?.parentElement).toHaveClass('px-4', 'pb-4', 'pt-4');
    expect(screen.queryByText('task-detail:task-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));

    expect(screen.getByText('task-list:grid:none:route')).toBeInTheDocument();
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

    expect(screen.getByText('task-list:grid:none:route')).toBeInTheDocument();
  });

  it('shows split view on desktop list mode and switches the selected task inline', () => {
    isDesktopViewport = true;

    render(<TasksPage />);

    const inlineTaskList = screen.getByText('task-list:list:task-1:inline');

    expect(inlineTaskList).toBeInTheDocument();
    expect(inlineTaskList.parentElement).toHaveClass('md:w-[19.2rem]', 'lg:w-[20.8rem]', 'xl:w-[24rem]');
    expect(screen.getByText('task-detail:task-1:no-header')).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith('/app/tasks?taskId=task-1', { scroll: false });
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Task 2',
        showConnectionStatus: true,
        connectionTaskId: 'task-1',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-task-2' }));

    expect(screen.getByText('task-list:list:task-2:inline')).toBeInTheDocument();
    expect(screen.getByText('task-detail:task-2:no-header')).toBeInTheDocument();
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Task 2',
        showConnectionStatus: true,
        connectionTaskId: 'task-2',
      }),
    );
  });

  it('keeps inline selection when clicking a new task with an existing taskId in the URL', () => {
    isDesktopViewport = true;
    searchParamsState = new URLSearchParams('taskId=task-1');

    render(<TasksPage />);

    replaceMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'select-task-2' }));

    expect(screen.getByText('task-list:list:task-2:inline')).toBeInTheDocument();
    expect(screen.getByText('task-detail:task-2:no-header')).toBeInTheDocument();
    expect(replaceMock).toHaveBeenCalledWith('/app/tasks?taskId=task-2', { scroll: false });
  });

  it('follows incoming taskId search param changes in desktop list mode', () => {
    isDesktopViewport = true;

    const { rerender } = render(<TasksPage />);

    expect(screen.getByText('task-detail:task-1:no-header')).toBeInTheDocument();

    replaceMock.mockClear();
    searchParamsState = new URLSearchParams('taskId=task-2');
    rerender(<TasksPage />);

    expect(screen.getByText('task-list:list:task-2:inline')).toBeInTheDocument();
    expect(screen.getByText('task-detail:task-2:no-header')).toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('keeps the first desktop list-mode task creation in the split pane flow', () => {
    isDesktopViewport = true;
    tasksState = {
      ...tasksState,
      tasks: [],
    };

    render(<TasksPage />);

    expect(screen.getByText('task-list:list:none:route')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    expect(screen.getByText('create-dialog')).toBeInTheDocument();

    tasksState = {
      ...tasksState,
      tasks: [{ id: 'task-3' }],
    };
    fireEvent.click(screen.getByRole('button', { name: 'mock-create-success' }));

    expect(screen.getByText('task-list:list:task-3:inline')).toBeInTheDocument();
    expect(screen.getByText('task-detail:task-3:no-header')).toBeInTheDocument();
  });

  it('disables the desktop detail pane when switching from list to grid', () => {
    isDesktopViewport = true;

    render(<TasksPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Grid view' }));

    expect(screen.getByText('task-list:grid:none:route')).toBeInTheDocument();
    expect(screen.queryByText('task-detail:task-1:no-header')).not.toBeInTheDocument();
    expect(headerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'Task 2',
        showConnectionStatus: false,
        connectionTaskId: null,
      }),
    );
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import TaskDetailPage from './page';

const DESKTOP_MEDIA_QUERY = '(min-width: 768px)';

const makeTask = (id: string, title: string) => ({
  id,
  projectId: 'project-1',
  title,
  taskType: 'ai_task',
  status: 'running',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: null,
});

const pushMock = vi.fn();
const replaceMock = vi.fn();
const fetchTaskMock = vi.fn();
const markTaskReadMock = vi.fn();
const headerMock = vi.fn();
let searchParamsState = new URLSearchParams();
let taskIdState = 'task-pty-1';
let isDesktopState = false;
let tasksState: Array<{
  id: string;
  projectId?: string | null;
  title: string;
  taskType: string;
  status: string;
  createdAt: string;
  updatedAt: string | null;
  metadata?: Record<string, unknown> | null;
}> = [];
let projectsState: Array<{
  id: string;
  name: string;
  daemonHost: string | null;
}> = [];

vi.mock('next/navigation', () => ({
  useParams: () => ({ taskId: taskIdState }),
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  useSearchParams: () => ({
    get: (key: string) => searchParamsState.get(key),
  }),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    showBack,
    onBack,
    showConnectionStatus,
    onTitleSwipeLeft,
    onTitleSwipeRight,
    titleSwipePreviewLeft,
    titleSwipePreviewRight,
  }: {
    title: string;
    showBack?: boolean;
    onBack?: () => void;
    showConnectionStatus?: boolean;
    onTitleSwipeLeft?: () => void;
    onTitleSwipeRight?: () => void;
    titleSwipePreviewLeft?: string | null;
    titleSwipePreviewRight?: string | null;
  }) => {
    headerMock({
      title,
      showBack,
      showConnectionStatus,
      onTitleSwipeLeft,
      onTitleSwipeRight,
      titleSwipePreviewLeft,
      titleSwipePreviewRight,
    });
    return (
      <div>
        {showBack ? (
          <button type="button" onClick={onBack}>
            back
          </button>
        ) : null}
        <div>{title}</div>
        {onTitleSwipeLeft ? (
          <button type="button" onClick={onTitleSwipeLeft}>swipe left</button>
        ) : null}
        {onTitleSwipeRight ? (
          <button type="button" onClick={onTitleSwipeRight}>swipe right</button>
        ) : null}
      </div>
    );
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
    tasks: typeof tasksState;
    fetchTask: typeof fetchTaskMock;
    markTaskRead: typeof markTaskReadMock;
  }) => unknown) => {
    const state = {
      tasks: tasksState,
      fetchTask: fetchTaskMock,
      markTaskRead: markTaskReadMock,
    };

    return typeof selector === 'function' ? selector(state) : state;
  },
  orderTasksWithPinnedFirst: <T,>(tasks: T[]) => tasks,
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: {
    selectedProjectId: string | null;
    projects: typeof projectsState;
    hiddenProjectIds: string[];
  }) => unknown) => selector({
    selectedProjectId: 'selected-project',
    projects: projectsState,
    hiddenProjectIds: [],
  }),
}));

vi.mock('@/features/auth/store', () => ({
  useAuthStore: (selector: (state: { session: { user: { id: string } } }) => unknown) =>
    selector({ session: { user: { id: 'user-1' } } }),
}));

vi.mock('@/features/user-preferences/store', () => ({
  useUserPreferencesStore: (selector: (state: { taskListRunningOnly: boolean }) => unknown) =>
    selector({ taskListRunningOnly: false }),
}));

describe('TaskDetailPage', () => {
  beforeEach(() => {
    fetchTaskMock.mockReset();
    markTaskReadMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
    headerMock.mockReset();
    searchParamsState = new URLSearchParams();
    taskIdState = 'task-pty-1';
    isDesktopState = false;
    tasksState = [
      {
        id: 'task-pty-1',
        projectId: 'project-1',
        title: 'Persisted PTY',
        taskType: 'pty_task',
        status: 'killed',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:05:00.000Z',
      },
    ];
    projectsState = [{ id: 'project-1', name: 'Project One', daemonHost: null }];
    window.localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => ({
        matches: isDesktopState,
        media: DESKTOP_MEDIA_QUERY,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
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

  it('prefers a safe graph return href when present', async () => {
    searchParamsState.set('from', '/app/tasks?projectId=project-1&view=graph');

    render(<TaskDetailPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'back' }));

    expect(pushMock).toHaveBeenCalledWith('/app/tasks?projectId=project-1&view=graph');
  });

  it('swipes between visible task-list rows and skips inactive merged tabs', async () => {
    taskIdState = 'task-3';
    tasksState = [
      makeTask('task-1', 'First'),
      makeTask('task-2', 'Hidden merged tab'),
      makeTask('task-3', 'Selected merged tab'),
      makeTask('task-4', 'Fourth'),
    ];
    searchParamsState.set('from', '/app/tasks?projectId=project-1');
    window.localStorage.setItem(
      'conductor:task-list-groups:v2:user-1:projects%3Aproject-1',
      JSON.stringify([{
        id: 'group-1',
        taskIds: ['task-2', 'task-3'],
        activeIndex: 1,
        labels: {},
      }]),
    );

    render(<TaskDetailPage />);

    await waitFor(() => {
      expect(headerMock).toHaveBeenLastCalledWith(expect.objectContaining({
        titleSwipePreviewLeft: 'First',
        titleSwipePreviewRight: 'Fourth',
      }));
    });

    fireEvent.click(screen.getByRole('button', { name: 'swipe left' }));
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/tasks/task-4?from=%2Fapp%2Ftasks%3FprojectId%3Dproject-1',
      { scroll: false },
    );

    fireEvent.click(screen.getByRole('button', { name: 'swipe right' }));
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/tasks/task-1?from=%2Fapp%2Ftasks%3FprojectId%3Dproject-1',
      { scroll: false },
    );
    expect(replaceMock).not.toHaveBeenCalledWith(
      expect.stringContaining('task-2'),
      expect.anything(),
    );
  });

  it('does not wrap at the first task-list row', async () => {
    taskIdState = 'task-1';
    tasksState = [makeTask('task-1', 'First'), makeTask('task-2', 'Second')];
    searchParamsState.set('from', '/app/tasks?projectId=project-1');

    render(<TaskDetailPage />);

    expect(await screen.findByRole('button', { name: 'swipe left' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'swipe right' })).not.toBeInTheDocument();
  });

  it('keeps title task switching disabled on desktop and for graph returns', async () => {
    taskIdState = 'task-1';
    tasksState = [makeTask('task-1', 'First'), makeTask('task-2', 'Second')];
    isDesktopState = true;

    const { unmount } = render(<TaskDetailPage />);
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'swipe left' })).not.toBeInTheDocument();
    unmount();

    isDesktopState = false;
    searchParamsState.set('from', '/app/tasks?projectId=project-1&view=graph');
    render(<TaskDetailPage />);
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'swipe left' })).not.toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TasksPage from './page';
import { useUserPreferencesStore } from '@/features/user-preferences/store';

const apiClientMock = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
}));
const pushToastMock = vi.hoisted(() => vi.fn());

const setProjectFilterMock = vi.fn();
const setProjectGroupFilterMock = vi.fn();
const setSelectedProjectIdMock = vi.fn();
const fetchTasksMock = vi.fn();
const fetchTasksForProjectsMock = vi.fn();
const pushMock = vi.fn();
const replaceMock = vi.fn();
const headerMock = vi.fn();

let tasksState: {
  setProjectFilter: typeof setProjectFilterMock;
  setProjectGroupFilter: typeof setProjectGroupFilterMock;
  fetchTasks: typeof fetchTasksMock;
  fetchTasksForProjects: typeof fetchTasksForProjectsMock;
  isLoading: boolean;
  currentProjectFilter: string | null;
  tasks: Array<{ id: string; projectId?: string | null; status?: string }>;
};
let searchParamsState = new URLSearchParams();
let isDesktopViewport = false;
let hiddenProjectIdsState: string[] = [];
let agentsState: Array<{ id: string; host: string }> = [];
type MockProject = {
  id: string;
  name: string;
  daemonHost?: string | null;
  gitRemoteUrl?: string | null;
  mergeOptOut?: boolean;
  hidden?: boolean;
  workspacePath?: string | null;
  collaborationId?: string | null;
  collaboration?: {
    id: string;
    inviteToken: string;
    memberCount: number;
    maxMembers: number;
    members: Array<unknown>;
  } | null;
  metadata?: Record<string, unknown> | null;
};
let projectsState: MockProject[] = [
  { id: 'project-1', name: 'Conductor' },
  { id: 'project-hidden', name: 'Hidden' },
];

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: (url: string, opts?: unknown) => {
      const qIdx = url.indexOf('?');
      searchParamsState = qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();
      replaceMock(url, opts);
    },
  }),
  useSearchParams: () => ({
    get: (key: string) => searchParamsState.get(key),
    toString: () => searchParamsState.toString(),
  }),
}));

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => apiClientMock,
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({ pushToast: pushToastMock }),
}));

vi.mock('@/features/tasks', async () => {
  const React = await import('react');
  return {
    useTasksStore: (selector: (state: typeof tasksState) => unknown) => selector(tasksState),
    filterTasksByProject: (
      tasks: Array<{ projectId?: string | null }>,
      projectFilter: string | string[] | null,
      hiddenProjectIds: string[] = [],
    ) => {
      const hiddenProjectIdSet = new Set(hiddenProjectIds);
      const rawIds = Array.isArray(projectFilter)
        ? projectFilter
        : projectFilter
          ? [projectFilter]
          : [];
      const normalized = rawIds.filter((id): id is string => Boolean(id));
      if (normalized.length > 0) {
        const visibleIds = normalized.filter((id) => !hiddenProjectIdSet.has(id));
        if (visibleIds.length === 0) return [];
        const visibleSet = new Set(visibleIds);
        return tasks.filter((task) => !!task.projectId && visibleSet.has(task.projectId));
      }
      return tasks.filter((task) => !task.projectId || !hiddenProjectIdSet.has(task.projectId));
    },
    RefreshIcon: ({ spinning = false }: { spinning?: boolean }) => <span>{spinning ? 'spinning' : 'refresh'}</span>,
    TaskList: ({
      viewMode,
      activeTaskId,
      onOpenTask,
      runningOnly,
      projectFilter,
    }: {
      viewMode: string;
      activeTaskId?: string | null;
      onOpenTask?: (taskId: string) => void;
      runningOnly?: boolean;
      projectFilter?: string | string[] | null;
    }) => {
      // Surface projectFilter so tests can assert the page passed the right
      // shape (single string vs expanded merged-group array). Earlier the
      // mock ignored this prop, which silently masked a "single-pane render
      // path still used the raw projectId" bug.
      const projectFilterTag = projectFilter == null
        ? 'none'
        : Array.isArray(projectFilter)
          ? `group:${projectFilter.join(',')}`
          : `single:${projectFilter}`;
      const openMode = onOpenTask ? (viewMode === 'graph' ? 'graph-open' : 'inline') : 'route';
      return (
        <>
          <div>task-list:{viewMode}:{activeTaskId ?? 'none'}:{openMode}</div>
          <div>running-only:{runningOnly ? 'yes' : 'no'}</div>
          <div>project-filter:{projectFilterTag}</div>
          <button type="button" onClick={() => onOpenTask?.('task-2')}>
            select-task-2
          </button>
        </>
      );
    },
    CreateTaskDialog: ({
      open,
      onClose,
      onCreatedTask,
      defaultProjectId,
    }: {
      open: boolean;
      onClose: () => void;
      onCreatedTask?: (taskId: string) => void;
      defaultProjectId?: string | null;
    }) => open ? (
      <div>
        <div>create-dialog:{defaultProjectId ?? 'none'}</div>
        <button type="button" onClick={() => onCreatedTask?.('task-3')}>
          mock-create-success
        </button>
        <button type="button" onClick={onClose}>
          mock-close-create
        </button>
      </div>
    ) : null,
    TaskDetailPane: ({ taskId, hideHeader }: { taskId: string; hideHeader?: boolean }) => (
      <div>task-detail:{taskId}:{hideHeader ? 'no-header' : 'header'}</div>
    ),
  };
});

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: {
    projects: MockProject[];
    hiddenProjectIds: string[];
    setSelectedProjectId: typeof setSelectedProjectIdMock;
  }) => unknown) =>
    selector({
      projects: projectsState,
      hiddenProjectIds: hiddenProjectIdsState,
      setSelectedProjectId: setSelectedProjectIdMock,
    }),
}));

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: { agents: Array<{ id: string; host: string }> }) => unknown) =>
    selector({ agents: agentsState }),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    actions,
    showConnectionStatus,
    connectionTaskId,
    onTitleDoubleClick,
    onTitleSwipeLeft,
    onTitleSwipeRight,
    onTitleSwipeProgress,
    titleSwipePreviewLeft,
    titleSwipePreviewRight,
    titleTransitionDirection,
    titleDoubleClickHint,
  }: {
    title?: string;
    actions?: React.ReactNode;
    showConnectionStatus?: boolean;
    connectionTaskId?: string | null;
    onTitleDoubleClick?: () => void;
    onTitleSwipeLeft?: () => void;
    onTitleSwipeRight?: () => void;
    onTitleSwipeProgress?: (state: { progress: number; direction: 'left' | 'right' | null; isDragging: boolean }) => void;
    titleSwipePreviewLeft?: string | null;
    titleSwipePreviewRight?: string | null;
    titleTransitionDirection?: 'forward' | 'backward' | null;
    titleDoubleClickHint?: string;
  }) => {
    headerMock({
      title,
      showConnectionStatus,
      connectionTaskId,
      titleDoubleClickHint,
      hasTitleSwipeLeft: Boolean(onTitleSwipeLeft),
      hasTitleSwipeRight: Boolean(onTitleSwipeRight),
      hasTitleSwipeProgress: Boolean(onTitleSwipeProgress),
      titleSwipePreviewLeft,
      titleSwipePreviewRight,
      titleTransitionDirection,
    });
    return (
      <div>
        <h1 onDoubleClick={onTitleDoubleClick} title={titleDoubleClickHint}>{title}</h1>
        {onTitleSwipeLeft ? (
          <button type="button" onClick={onTitleSwipeLeft}>
            mock-title-swipe-left
          </button>
        ) : null}
        {onTitleSwipeRight ? (
          <button type="button" onClick={onTitleSwipeRight}>
            mock-title-swipe-right
          </button>
        ) : null}
        {onTitleSwipeProgress ? (
          <>
            <button
              type="button"
              onClick={() => onTitleSwipeProgress({ progress: -0.5, direction: 'left', isDragging: true })}
            >
              mock-title-swipe-progress-left
            </button>
            <button
              type="button"
              onClick={() => onTitleSwipeProgress({ progress: 0, direction: null, isDragging: false })}
            >
              mock-title-swipe-progress-reset
            </button>
          </>
        ) : null}
        <div>{actions}</div>
      </div>
    );
  },
}));

describe('TasksPage', () => {
  beforeEach(() => {
    localStorage.clear();
    searchParamsState = new URLSearchParams();
    isDesktopViewport = false;
    hiddenProjectIdsState = [];
    agentsState = [];
    projectsState = [
      { id: 'project-1', name: 'Conductor' },
      { id: 'project-hidden', name: 'Hidden' },
    ];
    setProjectFilterMock.mockReset();
    setProjectGroupFilterMock.mockReset();
    setSelectedProjectIdMock.mockReset();
    fetchTasksMock.mockReset();
    fetchTasksForProjectsMock.mockReset();
    pushMock.mockReset();
    replaceMock.mockReset();
    headerMock.mockReset();
    pushToastMock.mockReset();
    apiClientMock.get.mockReset();
    apiClientMock.patch.mockReset();
    apiClientMock.get.mockResolvedValue({ tasksRunningOnly: false });
    apiClientMock.patch.mockImplementation(async (_path: string, body: { tasksRunningOnly?: boolean }) => ({
      tasksRunningOnly: body.tasksRunningOnly === true,
    }));
    useUserPreferencesStore.setState({
      taskListRunningOnly: false,
      taskListPreferencesHydrated: false,
      taskListPreferencesLoading: false,
      taskListPreferencesError: null,
    });

    tasksState = {
      setProjectFilter: setProjectFilterMock,
      setProjectGroupFilter: setProjectGroupFilterMock,
      fetchTasks: fetchTasksMock,
      fetchTasksForProjects: fetchTasksForProjectsMock,
      isLoading: false,
      currentProjectFilter: 'project-1',
      tasks: [
        { id: 'task-1', projectId: 'project-1', status: 'running' },
        { id: 'task-2', projectId: 'project-1', status: 'running' },
      ],
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

  it('renders header controls with list view', () => {
    render(<TasksPage />);

    expect(screen.getByText('Tasks(2)')).toBeInTheDocument();
    const taskList = screen.getByText('task-list:list:none:route');
    expect(taskList).toBeInTheDocument();
    expect(screen.getByText('running-only:no')).toBeInTheDocument();
    expect(taskList.parentElement?.parentElement).toHaveClass('px-4', 'pb-4', 'pt-4');
    expect(screen.queryByText('task-detail:task-1')).not.toBeInTheDocument();
  });

  it('refreshes tasks from the title bar controls', () => {
    searchParamsState = new URLSearchParams('projectId=project-1');

    render(<TasksPage />);

    expect(screen.getByText('Conductor (2 tasks)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));

    expect(fetchTasksMock).toHaveBeenCalledWith('project-1', { recoverStale: true });
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
        title: 'Tasks(2)',
        titleDoubleClickHint: 'Double-click to show running tasks only.',
        showConnectionStatus: true,
        connectionTaskId: 'task-1',
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-task-2' }));

    expect(screen.getByText('task-list:list:task-2:inline')).toBeInTheDocument();
    expect(screen.getByText('task-detail:task-2:no-header')).toBeInTheDocument();
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Tasks(2)',
        titleDoubleClickHint: 'Double-click to show running tasks only.',
        showConnectionStatus: true,
        connectionTaskId: 'task-2',
      }),
    );
  });

  it('shows graph view as a full-page task surface when enabled for the project', () => {
    isDesktopViewport = true;
    searchParamsState = new URLSearchParams('projectId=project-1&view=graph');
    projectsState = [
      { id: 'project-1', name: 'Conductor', metadata: { taskGraphEnabled: true } },
    ];

    render(<TasksPage />);

    expect(screen.getByText('task-list:graph:none:graph-open')).toBeInTheDocument();
    expect(screen.getByText('project-filter:group:project-1')).toBeInTheDocument();
    expect(screen.queryByText(/task-detail:/)).not.toBeInTheDocument();
    expect(replaceMock).not.toHaveBeenCalledWith('/app/tasks?projectId=project-1&taskId=task-1', { scroll: false });
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Conductor (2 tasks)',
        showConnectionStatus: false,
        connectionTaskId: null,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'select-task-2' }));

    expect(pushMock).toHaveBeenCalledWith(
      '/app/tasks/task-2?from=%2Fapp%2Ftasks%3FprojectId%3Dproject-1%26view%3Dgraph',
    );
  });

  it('toggles running-only tasks when double-clicking the Tasks title', () => {
    tasksState = {
      ...tasksState,
      tasks: [
        { id: 'task-1', projectId: 'project-1', status: 'running' },
        { id: 'task-killing', projectId: 'project-1', status: 'killing' },
        { id: 'task-2', projectId: 'project-1', status: 'completed' },
      ],
    };

    render(<TasksPage />);

    expect(screen.getByRole('heading', { name: 'Tasks(3)' })).toHaveAttribute(
      'title',
      'Double-click to show running tasks only.',
    );
    expect(screen.getByText('running-only:no')).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Tasks(3)' }));

    expect(apiClientMock.patch).toHaveBeenCalledWith('/user-preferences/task-list', {
      tasksRunningOnly: true,
    });
    expect(screen.getByRole('heading', { name: 'Tasks(2)' })).toHaveAttribute(
      'title',
      'Double-click to show all tasks.',
    );
    expect(screen.getByText('running-only:yes')).toBeInTheDocument();

    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Tasks(2)' }));

    expect(apiClientMock.patch).toHaveBeenLastCalledWith('/user-preferences/task-list', {
      tasksRunningOnly: false,
    });
    expect(screen.getByRole('heading', { name: 'Tasks(3)' })).toHaveAttribute(
      'title',
      'Double-click to show running tasks only.',
    );
    expect(screen.getByText('running-only:no')).toBeInTheDocument();
  });

  it('rolls back the running-only preference and shows a toast when persistence fails', async () => {
    apiClientMock.patch.mockRejectedValueOnce(new Error('server unavailable'));
    tasksState = {
      ...tasksState,
      tasks: [
        { id: 'task-1', projectId: 'project-1', status: 'running' },
        { id: 'task-2', projectId: 'project-1', status: 'completed' },
      ],
    };

    render(<TasksPage />);

    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Tasks(2)' }));

    expect(apiClientMock.patch).toHaveBeenCalledWith('/user-preferences/task-list', {
      tasksRunningOnly: true,
    });
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tasks(2)' })).toHaveAttribute(
        'title',
        'Double-click to show running tasks only.',
      );
    });
    expect(screen.getByText('running-only:no')).toBeInTheDocument();
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Task view preference not saved',
      description: 'server unavailable',
      variant: 'error',
    });
  });

  it('hydrates the running-only title preference from the server', async () => {
    apiClientMock.get.mockResolvedValueOnce({ tasksRunningOnly: true });
    tasksState = {
      ...tasksState,
      tasks: [
        { id: 'task-1', projectId: 'project-1', status: 'running' },
        { id: 'task-2', projectId: 'project-1', status: 'completed' },
      ],
    };

    render(<TasksPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Tasks(1)' })).toHaveAttribute(
        'title',
        'Double-click to show all tasks.',
      );
    });
    expect(apiClientMock.get).toHaveBeenCalledWith('/user-preferences/task-list');
    expect(screen.getByText('running-only:yes')).toBeInTheDocument();
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
    expect(screen.getByText('create-dialog:none')).toBeInTheDocument();

    tasksState = {
      ...tasksState,
      tasks: [{ id: 'task-3', status: 'running' }],
    };
    fireEvent.click(screen.getByRole('button', { name: 'mock-create-success' }));

    expect(screen.getByText('task-list:list:task-3:inline')).toBeInTheDocument();
    expect(screen.getByText('task-detail:task-3:no-header')).toBeInTheDocument();
  });

  it('passes the current project to the create task dialog', () => {
    searchParamsState = new URLSearchParams('projectId=project-1');

    render(<TasksPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));

    expect(screen.getByText('create-dialog:project-1')).toBeInTheDocument();
  });

  it('swipes the mobile task title left to switch to the next project', () => {
    searchParamsState = new URLSearchParams(
      'projectId=project-1&taskId=task-1&view=graph&taskType=pty_task&daemonHost=daemon-a&backend=codex',
    );
    projectsState = [
      { id: 'project-1', name: 'Conductor' },
      { id: 'project-2', name: 'Website' },
      { id: 'project-3', name: 'CLI' },
    ];

    render(<TasksPage />);

    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hasTitleSwipeLeft: true,
        hasTitleSwipeRight: false,
        hasTitleSwipeProgress: true,
        titleSwipePreviewLeft: null,
        titleSwipePreviewRight: 'Website',
      }),
    );

    setSelectedProjectIdMock.mockClear();
    replaceMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'mock-title-swipe-left' }));

    expect(setSelectedProjectIdMock).toHaveBeenCalledWith('project-2');
    expect(headerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        titleTransitionDirection: 'forward',
      }),
    );
    expect(replaceMock).toHaveBeenCalledWith(
      '/app/tasks?projectId=project-2&taskType=pty_task&daemonHost=daemon-a&backend=codex',
      { scroll: false },
    );
  });

  it('swipes the mobile task title right to switch to the previous project', () => {
    searchParamsState = new URLSearchParams('projectId=project-2&taskId=task-1');
    projectsState = [
      { id: 'project-1', name: 'Conductor' },
      { id: 'project-2', name: 'Website' },
      { id: 'project-3', name: 'CLI' },
    ];

    render(<TasksPage />);

    setSelectedProjectIdMock.mockClear();
    replaceMock.mockClear();
    expect(headerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hasTitleSwipeLeft: true,
        hasTitleSwipeRight: true,
        titleSwipePreviewLeft: 'Conductor',
        titleSwipePreviewRight: 'CLI',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'mock-title-swipe-right' }));

    expect(setSelectedProjectIdMock).toHaveBeenCalledWith('project-1');
    expect(headerMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        titleTransitionDirection: 'backward',
      }),
    );
    expect(replaceMock).toHaveBeenCalledWith('/app/tasks?projectId=project-1', { scroll: false });
  });

  it('does not wrap project title swipes past the project list edges', () => {
    searchParamsState = new URLSearchParams('projectId=project-1');
    projectsState = [
      { id: 'project-1', name: 'Conductor' },
      { id: 'project-2', name: 'Website' },
    ];

    render(<TasksPage />);

    setSelectedProjectIdMock.mockClear();
    replaceMock.mockClear();

    expect(screen.queryByRole('button', { name: 'mock-title-swipe-right' })).not.toBeInTheDocument();
    expect(setSelectedProjectIdMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('moves the mobile task list with the title swipe progress', () => {
    searchParamsState = new URLSearchParams('projectId=project-2');
    projectsState = [
      { id: 'project-1', name: 'Conductor' },
      { id: 'project-2', name: 'Website' },
      { id: 'project-3', name: 'CLI' },
    ];

    render(<TasksPage />);

    const taskListWrapper = screen.getByText('task-list:list:none:route').parentElement;
    expect(taskListWrapper).toHaveClass('webapp-task-list-swipe-follow');

    fireEvent.click(screen.getByRole('button', { name: 'mock-title-swipe-progress-left' }));

    expect(taskListWrapper).toHaveClass('webapp-task-list-swipe-follow-dragging');
    expect(taskListWrapper).toHaveStyle({
      opacity: '0.92',
      transform: 'translateX(-7px)',
    });

    fireEvent.click(screen.getByRole('button', { name: 'mock-title-swipe-progress-reset' }));

    expect(taskListWrapper).not.toHaveClass('webapp-task-list-swipe-follow-dragging');
    expect(taskListWrapper).not.toHaveStyle('transform: translateX(-7px)');
  });

  it('excludes hidden project tasks when no project is selected', () => {
    hiddenProjectIdsState = ['project-hidden'];
    tasksState = {
      ...tasksState,
      tasks: [
        { id: 'task-1', projectId: 'project-1', status: 'running' },
        { id: 'task-hidden', projectId: 'project-hidden', status: 'running' },
      ],
    };

    render(<TasksPage />);

    expect(screen.getByText('Tasks(1)')).toBeInTheDocument();
  });

  it('expands a cross-daemon merged project so the task list shows tasks from every daemon', () => {
    // Two same-named projects on different daemons form a merged group.
    projectsState = [
      { id: 'proj-host-a', name: 'Shared', daemonHost: 'host-a' },
      { id: 'proj-host-b', name: 'Shared', daemonHost: 'host-b' },
    ];
    // The URL only carries one member id — the page must expand it to the
    // full group when fetching and filtering.
    searchParamsState = new URLSearchParams('projectId=proj-host-a');
    tasksState = {
      ...tasksState,
      tasks: [
        { id: 'task-a', projectId: 'proj-host-a', status: 'running' },
        { id: 'task-b', projectId: 'proj-host-b', status: 'running' },
      ],
    };

    render(<TasksPage />);

    expect(setProjectGroupFilterMock).toHaveBeenCalledWith(['proj-host-a', 'proj-host-b']);
    expect(setProjectFilterMock).not.toHaveBeenCalled();
    expect(screen.getByText('Shared (2 tasks)')).toBeInTheDocument();
    // TaskList must receive the expanded group, not the raw URL projectId —
    // otherwise the page's task count is right but the rendered list filters
    // to a single daemon and looks empty when tasks live on the other one.
    expect(
      screen.getByText('project-filter:group:proj-host-a,proj-host-b'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh tasks' }));
    expect(fetchTasksForProjectsMock).toHaveBeenCalledWith(
      ['proj-host-a', 'proj-host-b'],
      { recoverStale: true },
    );
    expect(fetchTasksMock).not.toHaveBeenCalled();
  });

  it('swipes across merged project groups using the project list order', () => {
    projectsState = [
      { id: 'proj-host-a', name: 'Shared', daemonHost: 'host-a' },
      { id: 'proj-host-b', name: 'Shared', daemonHost: 'host-b' },
      { id: 'proj-next', name: 'Next' },
    ];
    agentsState = [
      { id: 'agent-a', host: 'host-a' },
      { id: 'agent-b', host: 'host-b' },
    ];
    searchParamsState = new URLSearchParams('projectId=proj-host-b&taskId=task-b');

    render(<TasksPage />);

    setSelectedProjectIdMock.mockClear();
    replaceMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'mock-title-swipe-left' }));

    expect(setSelectedProjectIdMock).toHaveBeenCalledWith('proj-next');
    expect(replaceMock).toHaveBeenCalledWith('/app/tasks?projectId=proj-next', { scroll: false });
  });

  it('expands the merged project in the desktop split-pane render path too', () => {
    isDesktopViewport = true;
    projectsState = [
      { id: 'proj-host-a', name: 'Shared', daemonHost: 'host-a' },
      { id: 'proj-host-b', name: 'Shared', daemonHost: 'host-b' },
    ];
    searchParamsState = new URLSearchParams('projectId=proj-host-a');
    tasksState = {
      ...tasksState,
      tasks: [
        { id: 'task-a', projectId: 'proj-host-a', status: 'running' },
        { id: 'task-b', projectId: 'proj-host-b', status: 'running' },
      ],
    };

    render(<TasksPage />);

    expect(
      screen.getByText('project-filter:group:proj-host-a,proj-host-b'),
    ).toBeInTheDocument();
  });

  it('clears a hidden projectId from the URL', () => {
    hiddenProjectIdsState = ['project-hidden'];
    searchParamsState = new URLSearchParams('projectId=project-hidden&taskId=task-1');

    render(<TasksPage />);

    expect(setProjectFilterMock).toHaveBeenCalledWith(null);
    expect(setSelectedProjectIdMock).toHaveBeenCalledWith(null);
    expect(replaceMock).toHaveBeenCalledWith('/app/tasks?taskId=task-1', { scroll: false });
  });

});

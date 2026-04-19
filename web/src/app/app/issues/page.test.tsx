import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import IssuesPage from './page';

const fetchProjectsMock = vi.fn();
const setSelectedProjectIdMock = vi.fn();
const fetchIssuesMock = vi.fn();
const moveIssueMock = vi.fn();
const deleteIssueMock = vi.fn();
const replaceMock = vi.fn();
const pushToastMock = vi.fn();

let searchParamsState = new URLSearchParams();
let isDesktopViewport = true;
let projectsState: {
  projects: Array<{ id: string; name: string; isDefault?: boolean }>;
  isLoading: boolean;
  fetchProjects: typeof fetchProjectsMock;
  setSelectedProjectId: typeof setSelectedProjectIdMock;
};
let issuesState: {
  issues: Array<{ id: string; projectId: string; title: string; status: 'backlog' | 'todo' | 'doing' | 'review' | 'done'; position: number; createdAt: string }>;
  isLoading: boolean;
  fetchIssues: typeof fetchIssuesMock;
  moveIssue: typeof moveIssueMock;
  deleteIssue: typeof deleteIssueMock;
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: replaceMock,
  }),
  useSearchParams: () => ({
    get: (key: string) => searchParamsState.get(key),
    toString: () => searchParamsState.toString(),
  }),
}));

vi.mock('@/components/common/FeedbackProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/common/FeedbackProvider')>();
  return {
    ...actual,
    useToast: () => ({ pushToast: pushToastMock }),
  };
});

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

vi.mock('@/features/issues', () => ({
  useIssuesStore: (selector: (state: typeof issuesState) => unknown) => selector(issuesState),
  IssueBoard: ({
    issues,
    isLoading,
    dragDisabled,
    onMoveIssue,
    onStatusChange,
    onDeleteIssue,
  }: {
    issues: typeof issuesState.issues;
    isLoading?: boolean;
    dragDisabled?: boolean;
    onMoveIssue: (issueId: string, status: 'backlog' | 'todo' | 'doing' | 'review' | 'done', position: number) => void;
    onStatusChange?: (issueId: string, status: 'backlog' | 'todo' | 'doing' | 'review' | 'done') => void;
    onDeleteIssue?: (issueId: string) => Promise<void> | void;
  }) => (
    <div>
      <div>issue-board:{issues.length}:{isLoading ? 'loading' : 'ready'}</div>
      <div>drag:{dragDisabled ? 'disabled' : 'enabled'}</div>
      <button type="button" onClick={() => onMoveIssue('issue-1', 'doing', 1.5)}>
        move-issue
      </button>
      <button type="button" onClick={() => onStatusChange?.('issue-1', 'doing')}>
        status-issue
      </button>
      <button type="button" onClick={() => void onDeleteIssue?.('issue-1')}>
        delete-issue
      </button>
    </div>
  ),
  IssueList: ({
    issues,
  }: {
    issues: typeof issuesState.issues;
  }) => <div>issue-list:{issues.length}</div>,
  CreateIssueDialog: ({
    open,
    projectId,
  }: {
    open: boolean;
    projectId: string | null;
  }) => (open ? <div>create-issue-dialog:{projectId ?? 'none'}</div> : null),
}));

vi.mock('@/features/tasks', () => ({
  RefreshIcon: ({ spinning = false }: { spinning?: boolean }) => (
    <span>{spinning ? 'spinning' : 'refresh'}</span>
  ),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    actions,
  }: {
    title?: string;
    actions?: React.ReactNode;
  }) => (
    <div>
      <h1>{title}</h1>
      <div>{actions}</div>
    </div>
  ),
}));

describe('IssuesPage', () => {
  beforeEach(() => {
    searchParamsState = new URLSearchParams();
    isDesktopViewport = true;
    fetchProjectsMock.mockReset();
    setSelectedProjectIdMock.mockReset();
    fetchIssuesMock.mockReset();
    moveIssueMock.mockReset();
    deleteIssueMock.mockReset();
    replaceMock.mockReset();
    pushToastMock.mockReset();

    projectsState = {
      projects: [
        { id: 'project-default', name: 'Default Project', isDefault: true },
        { id: 'project-2', name: 'Other Project' },
      ],
      isLoading: false,
      fetchProjects: fetchProjectsMock,
      setSelectedProjectId: setSelectedProjectIdMock,
    };
    issuesState = {
      issues: [
        {
          id: 'issue-1',
          projectId: 'project-default',
          title: 'Fix issue board',
          status: 'todo',
          position: 0,
          createdAt: '2026-04-14T00:00:00.000Z',
        },
        {
          id: 'issue-2',
          projectId: 'project-default',
          title: 'Ship navigation',
          status: 'doing',
          position: 1,
          createdAt: '2026-04-14T00:10:00.000Z',
        },
      ],
      isLoading: false,
      fetchIssues: fetchIssuesMock,
      moveIssue: moveIssueMock,
      deleteIssue: deleteIssueMock,
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

  it('lists all issues when projectId is missing', () => {
    render(<IssuesPage />);

    expect(fetchProjectsMock).toHaveBeenCalledTimes(1);
    expect(setSelectedProjectIdMock).toHaveBeenCalledWith(null);
    expect(fetchIssuesMock).toHaveBeenCalledWith(null);
    expect(replaceMock).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Issues' })).toBeInTheDocument();
    expect(screen.getByText('issue-board:2:ready')).toBeInTheDocument();
    expect(screen.getByText('drag:disabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create issue' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    expect(screen.getByText('create-issue-dialog:none')).toBeInTheDocument();
  });

  it('renders the project-scoped board and opens the create issue dialog', () => {
    searchParamsState = new URLSearchParams('projectId=project-default');

    render(<IssuesPage />);

    expect(screen.getByRole('heading', { name: 'Default Project (2 issues)' })).toBeInTheDocument();
    expect(screen.getByText('issue-board:2:ready')).toBeInTheDocument();
    expect(screen.getByText('drag:enabled')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh issues' }));
    expect(fetchIssuesMock).toHaveBeenLastCalledWith('project-default');

    fireEvent.click(screen.getByRole('button', { name: 'Create issue' }));
    expect(screen.getByText('create-issue-dialog:project-default')).toBeInTheDocument();
  });

  it('switches to list mode on mobile viewports', () => {
    isDesktopViewport = false;
    searchParamsState = new URLSearchParams('projectId=project-default');

    render(<IssuesPage />);

    expect(screen.getByText('issue-list:2')).toBeInTheDocument();
    expect(screen.queryByText('issue-board:2:ready')).toBeNull();
  });

  it('deletes issues through board callback and shows success toast', async () => {
    searchParamsState = new URLSearchParams('projectId=project-default');

    render(<IssuesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'delete-issue' }));

    await waitFor(() => {
      expect(deleteIssueMock).toHaveBeenCalledWith('issue-1');
    });
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Issue deleted',
      variant: 'success',
    });
  });

  it('uses same-project issues when changing status from all-project view', async () => {
    issuesState = {
      ...issuesState,
      issues: [
        {
          id: 'issue-1',
          projectId: 'project-a',
          title: 'Project A todo',
          status: 'todo',
          position: 0,
          createdAt: '2026-04-14T00:00:00.000Z',
        },
        {
          id: 'issue-2',
          projectId: 'project-b',
          title: 'Project B doing',
          status: 'doing',
          position: 100,
          createdAt: '2026-04-14T00:10:00.000Z',
        },
      ],
    };

    render(<IssuesPage />);

    fireEvent.click(screen.getByRole('button', { name: 'status-issue' }));

    expect(moveIssueMock).toHaveBeenCalledWith('issue-1', 'doing', 0);
  });

  it('clears an invalid projectId and fetches all issues', () => {
    searchParamsState = new URLSearchParams('projectId=missing&view=board');
    projectsState = {
      ...projectsState,
      projects: [],
    };

    render(<IssuesPage />);

    expect(setSelectedProjectIdMock).toHaveBeenCalledWith(null);
    expect(fetchIssuesMock).toHaveBeenCalledWith(null);
    expect(replaceMock).toHaveBeenCalledWith('/app/issues?view=board', { scroll: false });
    expect(screen.getByText('issue-board:2:ready')).toBeInTheDocument();
  });
});

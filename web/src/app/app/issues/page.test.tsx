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
    onMoveIssue,
    onDeleteIssue,
  }: {
    issues: typeof issuesState.issues;
    isLoading?: boolean;
    onMoveIssue: (issueId: string, status: 'backlog' | 'todo' | 'doing' | 'review' | 'done', position: number) => void;
    onDeleteIssue?: (issueId: string) => Promise<void> | void;
  }) => (
    <div>
      <div>issue-board:{issues.length}:{isLoading ? 'loading' : 'ready'}</div>
      <button type="button" onClick={() => onMoveIssue('issue-1', 'doing', 1.5)}>
        move-issue
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

  it('resolves /app/issues to the default project when projectId is missing', () => {
    render(<IssuesPage />);

    expect(fetchProjectsMock).toHaveBeenCalledTimes(1);
    expect(setSelectedProjectIdMock).toHaveBeenCalledWith('project-default');
    expect(fetchIssuesMock).toHaveBeenCalledWith('project-default');
    expect(replaceMock).toHaveBeenCalledWith('/app/issues?projectId=project-default', { scroll: false });
  });

  it('renders the project-scoped board and opens the create issue dialog', () => {
    searchParamsState = new URLSearchParams('projectId=project-default');

    render(<IssuesPage />);

    expect(screen.getByRole('heading', { name: 'Default Project (2 issues)' })).toBeInTheDocument();
    expect(screen.getByText('issue-board:2:ready')).toBeInTheDocument();

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

  it('shows an empty state when no default project can be resolved', () => {
    projectsState = {
      ...projectsState,
      projects: [],
    };

    render(<IssuesPage />);

    expect(screen.getByText('No default project yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open projects' })).toHaveAttribute('href', '/app/projects');
  });
});

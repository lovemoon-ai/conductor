import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { CreateIssueDialog } from './CreateIssueDialog';

const createIssueMock = vi.fn();
const clearErrorMock = vi.fn();
const fetchProjectsMock = vi.fn();
const pushToastMock = vi.fn();

let issuesState = {
  createIssue: createIssueMock,
  error: null as string | null,
  clearError: clearErrorMock,
};
let projectsState = {
  projects: [
    { id: 'project-default', name: 'Default Project', isDefault: true },
    { id: 'project-2', name: 'Other Project' },
  ],
  fetchProjects: fetchProjectsMock,
};

vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({
    open,
    title,
    children,
  }: {
    open: boolean;
    title: string;
    children: ReactNode;
  }) => open ? (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ) : null,
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

vi.mock('../store', () => ({
  useIssuesStore: (selector: (state: typeof issuesState) => unknown) => selector(issuesState),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

describe('CreateIssueDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issuesState = {
      createIssue: createIssueMock,
      error: null,
      clearError: clearErrorMock,
    };
    projectsState = {
      projects: [
        { id: 'project-default', name: 'Default Project', isDefault: true },
        { id: 'project-2', name: 'Other Project' },
      ],
      fetchProjects: fetchProjectsMock,
    };
  });

  it('creates an issue in the selected project when opened from all-project view', async () => {
    createIssueMock.mockResolvedValue({ id: 'issue-1' });

    render(<CreateIssueDialog open onClose={() => {}} projectId={null} />);

    fireEvent.change(screen.getByLabelText('Project'), {
      target: { value: 'project-2' },
    });
    fireEvent.change(screen.getByPlaceholderText('Summarize the issue'), {
      target: { value: 'Ship all-project issue creation' },
    });
    expect(screen.getByLabelText('Priority')).toHaveValue('P1');
    fireEvent.change(screen.getByLabelText('Priority'), {
      target: { value: 'P0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

    await waitFor(() => {
      expect(createIssueMock).toHaveBeenCalledWith({
        projectId: 'project-2',
        title: 'Ship all-project issue creation',
        description: null,
        status: 'todo',
        priority: 'P0',
      });
    });
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Issue created',
      description: 'Added to Todo.',
      variant: 'success',
    });
  });

  it('fetches projects and disables submit when no project is available', () => {
    projectsState = {
      projects: [],
      fetchProjects: fetchProjectsMock,
    };

    render(<CreateIssueDialog open onClose={() => {}} projectId={null} />);

    expect(fetchProjectsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText('No project available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Issue' })).toBeDisabled();
  });

  describe('cross-daemon merged group', () => {
    const mergedProjects = [
      {
        id: 'p-a',
        name: 'Alpha',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/alpha',
        repoRoot: '/repo/alpha',
        gitRemoteUrl: 'github.com/foo/alpha',
      },
      {
        id: 'p-b',
        name: 'Alpha',
        daemonHost: 'daemon-b',
        workspacePath: '/repo/alpha',
        repoRoot: '/repo/alpha',
        gitRemoteUrl: 'github.com/foo/alpha',
      },
    ];

    it('renders a target-daemon picker when the projectId belongs to a merged group', () => {
      projectsState = {
        projects: mergedProjects as any,
        fetchProjects: fetchProjectsMock,
      };

      render(<CreateIssueDialog open onClose={() => {}} projectId="p-a" />);

      const picker = screen.getByLabelText('Target daemon') as HTMLSelectElement;
      expect(picker).toBeInTheDocument();
      // Default selection is the projectId the parent passed in.
      expect(picker.value).toBe('p-a');
      // Both members are listed as options.
      expect(picker.options).toHaveLength(2);
    });

    it('hides the daemon picker for single-member groups', () => {
      projectsState = {
        projects: [mergedProjects[0]] as any,
        fetchProjects: fetchProjectsMock,
      };

      render(<CreateIssueDialog open onClose={() => {}} projectId="p-a" />);

      expect(screen.queryByLabelText('Target daemon')).toBeNull();
    });

    it('routes the create call to the daemon the user picks', async () => {
      projectsState = {
        projects: mergedProjects as any,
        fetchProjects: fetchProjectsMock,
      };
      createIssueMock.mockResolvedValue({ id: 'issue-1' });

      render(<CreateIssueDialog open onClose={() => {}} projectId="p-a" />);

      // User switches the target daemon to daemon-b.
      fireEvent.change(screen.getByLabelText('Target daemon'), {
        target: { value: 'p-b' },
      });
      fireEvent.change(screen.getByPlaceholderText('Summarize the issue'), {
        target: { value: 'Wire up endpoint' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

      await waitFor(() => {
        expect(createIssueMock).toHaveBeenCalledWith(
          expect.objectContaining({
            // The new issue lands on daemon-b's underlying project, NOT the
            // primary projectId the parent component passed in.
            projectId: 'p-b',
            title: 'Wire up endpoint',
            includeProject: true,
          }),
        );
      });
    });
  });
});

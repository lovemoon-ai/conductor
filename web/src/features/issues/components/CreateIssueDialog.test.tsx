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
let projectsState: {
  projects: Array<Record<string, unknown>>;
  fetchProjects: typeof fetchProjectsMock;
} = {
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

  it('does not expose owner selection during creation for shared projects', async () => {
    createIssueMock.mockResolvedValue({ id: 'issue-1' });
    projectsState = {
      projects: [
        {
          id: 'shared-project',
          name: 'Shared Project',
          collaboration: {
            id: 'collaboration-1',
            inviteToken: 'token',
            memberCount: 2,
            maxMembers: 5,
            members: [
              { id: 'member-1', userId: 'user-1', projectId: 'shared-project', label: '+8618707151525' },
              { id: 'member-2', userId: 'user-2', projectId: 'peer-project', label: '+8618707151526' },
            ],
          },
        },
      ],
      fetchProjects: fetchProjectsMock,
    };

    render(<CreateIssueDialog open onClose={() => {}} projectId="shared-project" />);

    expect(screen.queryByLabelText('Owner')).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('Summarize the issue'), {
      target: { value: 'Shared issue' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

    await waitFor(() => {
      expect(createIssueMock).toHaveBeenCalledWith({
        projectId: 'shared-project',
        title: 'Shared issue',
        description: null,
        status: 'todo',
        priority: 'P1',
      });
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

    it('does not render a target-daemon picker when the projectId belongs to a merged group', () => {
      projectsState = {
        projects: mergedProjects as any,
        fetchProjects: fetchProjectsMock,
      };

      render(<CreateIssueDialog open onClose={() => {}} projectId="p-a" />);

      expect(screen.queryByLabelText('Target daemon')).toBeNull();
      expect(screen.queryByLabelText('Owner')).toBeNull();
    });

    it('hides the daemon picker for single-member groups', () => {
      projectsState = {
        projects: [mergedProjects[0]] as any,
        fetchProjects: fetchProjectsMock,
      };

      render(<CreateIssueDialog open onClose={() => {}} projectId="p-a" />);

      expect(screen.queryByLabelText('Target daemon')).toBeNull();
    });

    it('defaults the create call to the provided project without target daemon selection', async () => {
      projectsState = {
        projects: mergedProjects as any,
        fetchProjects: fetchProjectsMock,
      };
      createIssueMock.mockResolvedValue({ id: 'issue-1' });

      render(<CreateIssueDialog open onClose={() => {}} projectId="p-a" />);

      fireEvent.change(screen.getByPlaceholderText('Summarize the issue'), {
        target: { value: 'Wire up endpoint' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

      await waitFor(() => {
        expect(createIssueMock).toHaveBeenCalledWith(
          expect.objectContaining({
            projectId: 'p-a',
            title: 'Wire up endpoint',
          }),
        );
      });
      expect(createIssueMock.mock.calls[0]?.[0]).not.toHaveProperty('includeProject');
    });
  });
});

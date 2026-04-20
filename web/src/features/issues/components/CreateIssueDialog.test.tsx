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
    fireEvent.click(screen.getByRole('button', { name: 'Create Issue' }));

    await waitFor(() => {
      expect(createIssueMock).toHaveBeenCalledWith({
        projectId: 'project-2',
        title: 'Ship all-project issue creation',
        description: null,
        status: 'todo',
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
});

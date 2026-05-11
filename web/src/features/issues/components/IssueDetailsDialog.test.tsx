import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Issue, Task } from '@/shared/types';
import { IssueDetailsDialog } from './IssueDetailsDialog';

const updateIssueMock = vi.fn();
const pushToastMock = vi.fn();

const baseTask: Task = {
  id: 'task-1',
  projectId: 'project-1',
  issueId: 'issue-1',
  title: 'Board implementation task',
  status: 'running',
  backendType: 'claude',
  sessionId: 'session-abc',
  sessionFilePath: null,
  createdAt: '2026-04-14T00:00:00.000Z',
  updatedAt: '2026-04-14T00:10:00.000Z',
};

const issue: Issue = {
  id: 'issue-1',
  projectId: 'project-1',
  title: 'Board implementation',
  description: 'Hook issue board into the app shell',
  status: 'todo',
  priority: 'P2',
  position: 1,
  metadata: { backendType: 'claude' },
  activeTask: baseTask,
  linkedTask: baseTask,
  tasks: [baseTask],
  createdAt: '2026-04-14T00:00:00.000Z',
  updatedAt: '2026-04-14T00:10:00.000Z',
};

let issuesState = {
  updateIssue: updateIssueMock,
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

vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

describe('IssueDetailsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issuesState = {
      updateIssue: updateIssueMock,
    };
  });

  it('renders the Issue Details title', () => {
    render(<IssueDetailsDialog open onClose={() => {}} issue={issue} />);
    expect(screen.getByRole('heading', { name: 'Issue Details' })).toBeInTheDocument();
  });

  it('hydrates the current priority into the select when opened', () => {
    render(<IssueDetailsDialog open onClose={() => {}} issue={issue} />);

    expect(screen.getByLabelText('Priority')).toHaveValue('P2');
  });

  it('submits the selected priority', async () => {
    const onClose = vi.fn();
    updateIssueMock.mockResolvedValue({ ...issue, priority: 'P0' });

    render(<IssueDetailsDialog open onClose={onClose} issue={issue} />);

    fireEvent.change(screen.getByLabelText('Priority'), {
      target: { value: 'P0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIssueMock).toHaveBeenCalledWith('issue-1', {
        priority: 'P0',
      });
    });
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Issue updated',
      variant: 'success',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('updates owner from the details dialog', async () => {
    const onClose = vi.fn();
    const ownedIssue: Issue = {
      ...issue,
      ownerUserId: 'user-1',
      owner: {
        id: 'user-1',
        label: '+8618707151525',
      },
    };
    updateIssueMock.mockResolvedValue({
      ...ownedIssue,
      ownerUserId: 'user-2',
    });

    render(
      <IssueDetailsDialog
        open
        onClose={onClose}
        issue={ownedIssue}
        ownerOptions={[
          { userId: 'user-1', label: '+8618707151525', projectName: 'Conductor A' },
          { userId: 'user-2', label: '+8618707151526', projectName: 'Conductor B' },
        ]}
      />,
    );

    expect(screen.getByLabelText('Owner')).toHaveValue('user-1');
    fireEvent.change(screen.getByLabelText('Owner'), {
      target: { value: 'user-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(updateIssueMock).toHaveBeenCalledWith('issue-1', {
        ownerUserId: 'user-2',
      });
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the ai tool, session id, and task id fields', () => {
    render(<IssueDetailsDialog open onClose={() => {}} issue={issue} />);

    expect(screen.getByText('AI tool')).toBeInTheDocument();
    expect(screen.getByText('claude')).toBeInTheDocument();
    expect(screen.getByText('Session IDs')).toBeInTheDocument();
    expect(screen.getByText('session-abc')).toBeInTheDocument();
    expect(screen.getByText('Task IDs')).toBeInTheDocument();

    const taskLink = screen.getByTitle('Open task task-1');
    expect(taskLink).toHaveAttribute('href', '/app/tasks/task-1');
  });

  it('renders only the latest task id as a clickable link when multiple tasks exist', () => {
    const olderTask: Task = {
      ...baseTask,
      id: 'task-0',
      sessionId: 'session-old',
      status: 'completed',
      createdAt: '2026-04-13T00:00:00.000Z',
      updatedAt: '2026-04-13T00:10:00.000Z',
    };
    const issueWithMultipleTasks: Issue = {
      ...issue,
      tasks: [baseTask, olderTask],
    };

    render(<IssueDetailsDialog open onClose={() => {}} issue={issueWithMultipleTasks} />);

    expect(screen.getByTitle('Open task task-1')).toHaveAttribute('href', '/app/tasks/task-1');
    expect(screen.queryByTitle('Open task task-0')).not.toBeInTheDocument();
    expect(screen.getByText('session-old')).toBeInTheDocument();
  });

  it('falls back to the persisted issue breadcrumb when the originating task is gone', () => {
    const issueWithoutTasks: Issue = {
      ...issue,
      metadata: null,
      activeTask: null,
      linkedTask: null,
      tasks: [],
      aiBackendType: 'codex',
      aiSessionId: '019daec0-aaaa-bbbb-cccc-deadbeef',
    };

    render(<IssueDetailsDialog open onClose={() => {}} issue={issueWithoutTasks} />);

    // AI tool falls through from issue.aiBackendType
    expect(screen.getByText('codex')).toBeInTheDocument();
    // Session id falls through from issue.aiSessionId, marked as archived
    expect(screen.getByText('019daec0-aaaa-bbbb-cccc-deadbeef')).toBeInTheDocument();
    expect(screen.getByText('archived')).toBeInTheDocument();
    // No task id shown — the originating task is gone
    expect(screen.getByText('No tasks yet')).toBeInTheDocument();
  });
});

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
});

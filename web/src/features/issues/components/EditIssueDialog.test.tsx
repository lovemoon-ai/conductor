import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Issue } from '@/shared/types';
import { EditIssueDialog } from './EditIssueDialog';

const updateIssueMock = vi.fn();
const pushToastMock = vi.fn();

const issue: Issue = {
  id: 'issue-1',
  projectId: 'project-1',
  title: 'Board implementation',
  description: 'Hook issue board into the app shell',
  status: 'todo',
  priority: 'P2',
  position: 1,
  metadata: null,
  activeTask: null,
  linkedTask: null,
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

describe('EditIssueDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    issuesState = {
      updateIssue: updateIssueMock,
    };
  });

  it('hydrates the current priority into the select when opened', () => {
    render(<EditIssueDialog open onClose={() => {}} issue={issue} />);

    expect(screen.getByLabelText('Priority')).toHaveValue('P2');
  });

  it('submits the selected priority', async () => {
    const onClose = vi.fn();
    updateIssueMock.mockResolvedValue({ ...issue, priority: 'P0' });

    render(<EditIssueDialog open onClose={onClose} issue={issue} />);

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
});

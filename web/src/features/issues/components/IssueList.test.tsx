import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue } from '@/shared/types';
import { IssueList } from './IssueList';

vi.mock('./IssueCard', () => ({
  IssueCard: ({ issue }: { issue: { title: string } }) => <div>{issue.title}</div>,
}));

describe('IssueList', () => {
  const issues: Issue[] = [
    {
      id: 'issue-1',
      projectId: 'project-1',
      title: 'Plan board UX',
      status: 'todo',
      position: 0,
      createdAt: '2026-04-14T00:00:00.000Z',
    },
    {
      id: 'issue-2',
      projectId: 'project-1',
      title: 'Build AI task handoff',
      status: 'doing',
      position: 1,
      createdAt: '2026-04-14T00:05:00.000Z',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to showing only non-empty status sections', () => {
    render(<IssueList issues={issues} />);

    expect(screen.getByRole('button', { name: 'Backlog' }).parentElement?.parentElement).toHaveClass('sticky');
    expect(screen.getByRole('button', { name: 'Todo(1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Doing(1)' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Backlog|Todo|Doing|Review|Done/ })).toBeNull();
    expect(screen.getByText('Plan board UX')).toBeInTheDocument();
    expect(screen.getByText('Build AI task handoff')).toBeInTheDocument();
  });

  it('shows or hides sections as status filters are toggled', () => {
    render(<IssueList issues={issues} />);

    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));
    expect(screen.getByRole('button', { name: 'Backlog' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: /^Doing(?:\(\d+\))?$/ }));
    expect(screen.queryByText('Build AI task handoff')).toBeNull();
    expect(screen.getByRole('button', { name: /^Doing(?:\(\d+\))?$/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows an empty hint when all status filters are disabled', () => {
    render(<IssueList issues={issues} />);

    fireEvent.click(screen.getByRole('button', { name: /^Todo(?:\(\d+\))?$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Doing(?:\(\d+\))?$/ }));

    expect(screen.getByText('Select at least one status to show issues.')).toBeInTheDocument();
  });
});

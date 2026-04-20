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

  it('defaults to showing the first non-empty status section', () => {
    render(<IssueList issues={issues} />);

    expect(screen.getByRole('button', { name: 'Todo(1)' }).parentElement?.parentElement).toHaveClass('sticky');
    expect(screen.getByRole('button', { name: 'Todo(1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Doing(1)' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Backlog' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Todo|Doing|Done/ })).toBeNull();
    expect(screen.getByText('Plan board UX')).toBeInTheDocument();
    expect(screen.queryByText('Build AI task handoff')).toBeNull();
  });

  it('shows only one status when filters are selected', () => {
    render(<IssueList issues={issues} />);

    fireEvent.click(screen.getByRole('button', { name: /^Doing(?:\(\d+\))?$/ }));
    expect(screen.queryByText('Plan board UX')).toBeNull();
    expect(screen.getByText('Build AI task handoff')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Todo(?:\(\d+\))?$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^Doing(?:\(\d+\))?$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows an empty hint for the selected status when it has no issues', () => {
    render(<IssueList issues={issues} />);

    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.queryByText('Plan board UX')).toBeNull();
    expect(screen.queryByText('Build AI task handoff')).toBeNull();
    expect(screen.getByText('No issues in Done.')).toBeInTheDocument();
  });
});

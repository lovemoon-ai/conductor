import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Issue } from '@/shared/types';
import { IssueCard } from './IssueCard';
import { pickDaemonBadgeClass } from './IssueCard.utils';

// dnd-kit pulls in browser APIs we don't need for these visibility tests; stub
// `useSortable` to a no-op so the card renders deterministically.
vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: null,
    isDragging: false,
  }),
}));

// Next.js's Link component is irrelevant to chip visibility — collapse it.
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
    <a {...rest}>{children}</a>
  ),
}));

const baseIssue = (overrides: Partial<Issue> = {}): Issue => ({
  id: 'issue-1',
  projectId: 'project-1',
  title: 'Wire up daemon chip',
  status: 'todo',
  priority: 'P1',
  position: 0,
  description: null,
  metadata: null,
  activeTask: null,
  linkedTask: null,
  createdAt: '2026-05-23T00:00:00.000Z',
  ...overrides,
});

describe('IssueCard daemon badge colors', () => {
  it('keeps a stable class for the same daemon host', () => {
    expect(pickDaemonBadgeClass('daemon-a')).toBe(pickDaemonBadgeClass('daemon-a'));
  });

  it('can assign different classes to different daemon hosts', () => {
    expect(pickDaemonBadgeClass('daemon-a')).not.toBe(pickDaemonBadgeClass('daemon-b'));
  });
});

describe('IssueCard daemon chip visibility', () => {
  const renderCard = (
    issue: Issue,
    multiDaemonContext: boolean,
  ) =>
    render(
      <IssueCard issue={issue} multiDaemonContext={multiDaemonContext} />,
    );

  it('hides the chip on a todo issue even when the project is multi-daemon (chip would lie about commitment)', () => {
    renderCard(
      baseIssue({
        status: 'todo',
        // metadata + linkedTask hostshouldn't matter — the gate is status.
        metadata: { daemonHost: 'daemon-a' },
        linkedTask: { id: 't', title: '', status: 'init', createdAt: '', agentHost: 'daemon-a' } as any,
      }),
      true,
    );

    expect(screen.queryByText(/daemon-a/)).toBeNull();
  });

  it('hides the chip on a single-daemon project even after the issue has moved to doing', () => {
    renderCard(
      baseIssue({
        status: 'doing',
        // Even with a running task on daemon-a, the chip stays hidden because
        // the parent decided the project is NOT in a multi-daemon context.
        activeTask: { id: 't', title: '', status: 'running', createdAt: '', agentHost: 'daemon-a' } as any,
      }),
      false,
    );

    expect(screen.queryByText(/daemon-a/)).toBeNull();
  });

  it('shows the chip when the issue is doing in a multi-daemon context and has an active task', () => {
    renderCard(
      baseIssue({
        status: 'doing',
        activeTask: { id: 't', title: '', status: 'running', createdAt: '', agentHost: 'daemon-b' } as any,
      }),
      true,
    );

    expect(screen.getByText('daemon-b')).toBeInTheDocument();
  });

  it('shows the chip from linkedTask.agentHost for a done issue (historical run, no active task)', () => {
    renderCard(
      baseIssue({
        status: 'done',
        linkedTask: { id: 't', title: '', status: 'completed', createdAt: '', agentHost: 'daemon-c' } as any,
      }),
      true,
    );

    expect(screen.getByText('daemon-c')).toBeInTheDocument();
  });

  it('falls back to metadata.daemonHost when no task has been spawned yet', () => {
    renderCard(
      baseIssue({
        status: 'doing',
        metadata: { daemonHost: 'daemon-d' },
      }),
      true,
    );

    expect(screen.getByText('daemon-d')).toBeInTheDocument();
  });

  it('still hides the chip on a todo issue when status was moved back from doing (metadata daemonHost lingers but does not lie)', () => {
    renderCard(
      baseIssue({
        status: 'todo',
        metadata: { daemonHost: 'daemon-stale' },
      }),
      true,
    );

    expect(screen.queryByText(/daemon-stale/)).toBeNull();
  });
});

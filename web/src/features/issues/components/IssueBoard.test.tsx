import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IssueBoard } from './IssueBoard';
import type { Issue } from '@/shared/types';
import { ISSUE_STATUS_BADGE_CLASSNAMES } from '@/lib/issues/config';

let latestDndContextProps: Record<string, any> | null = null;

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, ...props }: { children: React.ReactNode }) => {
    latestDndContextProps = props;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PointerSensor: class PointerSensor {},
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
  closestCenter: () => [],
  pointerWithin: () => [],
  useDroppable: () => ({
    setNodeRef: () => undefined,
    isOver: false,
  }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    setActivatorNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

describe('IssueBoard', () => {
  const onMoveIssue = vi.fn();
  const onStatusChange = vi.fn();
  const onDeleteIssue = vi.fn();
  const issues: Issue[] = [
    {
      id: 'issue-1',
      projectId: 'project-1',
      title: 'Plan board UX',
      description: 'Prepare the issue board interaction details',
      status: 'todo',
      priority: 'P1',
      position: 0,
      createdAt: '2026-04-14T00:00:00.000Z',
      updatedAt: '2026-04-14T00:00:00.000Z',
    },
    {
      id: 'issue-2',
      projectId: 'project-1',
      title: 'Build AI task handoff',
      description: 'Wire todo to doing task spawn',
      status: 'doing',
      priority: 'P1',
      position: 2,
      activeTask: {
        id: 'task-1',
        title: 'Implement issue spawn',
        status: 'running',
        createdAt: '2026-04-14T00:05:00.000Z',
      },
      createdAt: '2026-04-14T00:05:00.000Z',
      updatedAt: '2026-04-14T00:05:00.000Z',
    },
    {
      id: 'issue-3',
      projectId: 'project-1',
      title: 'Review task history link',
      description: 'Expose linked task entry on the card',
      status: 'doing',
      priority: 'P1',
      position: 4,
      linkedTask: {
        id: 'task-2',
        title: 'Historical task',
        status: 'killed',
        createdAt: '2026-04-14T00:08:00.000Z',
      },
      createdAt: '2026-04-14T00:10:00.000Z',
      updatedAt: '2026-04-14T00:10:00.000Z',
    },
  ];

  beforeEach(() => {
    latestDndContextProps = null;
    onMoveIssue.mockReset();
    onStatusChange.mockReset();
    onDeleteIssue.mockReset();
  });

  it('renders the simplified status columns and only the compact open-task action', () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    expect(screen.getByRole('heading', { name: /^Todo(?:\(\d+\))?$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Doing(?:\(\d+\))?$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Done(?:\(\d+\))?$/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Backlog(?:\(\d+\))?$/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Review(?:\(\d+\))?$/ })).toBeNull();
    const openTaskLink = screen.getByRole('link', { name: 'Open task' });
    expect(openTaskLink).toHaveAttribute('href', '/app/tasks/task-1');
    const issue2DeleteButton = screen.getByRole('button', { name: 'Delete issue Build AI task handoff' });
    expect(openTaskLink.parentElement).toBe(issue2DeleteButton.parentElement);
    expect(screen.getByRole('link', { name: 'Open last task' })).toHaveAttribute('href', '/app/tasks/task-2');
    expect(screen.queryByText('Active task')).toBeNull();
    expect(screen.queryByText('Implement issue spawn')).toBeNull();
  });

  it('opens the status menu and forwards status updates', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change status for Plan board UX' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move Plan board UX to Doing' }));
    });

    expect(onStatusChange).toHaveBeenCalledWith('issue-1', 'doing');
  });

  it('shows phone owners with the last two digits on the card', () => {
    const ownedIssues: Issue[] = [
      {
        ...issues[0],
        ownerUserId: 'user-1',
        owner: {
          id: 'user-1',
          label: '+8618707151525',
        },
      },
    ];
    const ownerOptionsByProjectId = new Map([
      ['project-1', [
        { userId: 'user-1', label: '+8618707151525', projectName: 'Project One' },
        { userId: 'user-2', label: '+8618707151526', projectName: 'Project Two' },
      ]],
    ]);

    render(
      <IssueBoard
        issues={ownedIssues}
        ownerOptionsByProjectId={ownerOptionsByProjectId}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    expect(screen.getByLabelText('Issue owner +8618707151525')).toHaveTextContent('25');
    expect(screen.queryByRole('button', { name: 'Assign Plan board UX to +8618707151526' })).toBeNull();
  });

  it('keeps status updates enabled when dragging is disabled', async () => {
    render(
      <IssueBoard
        issues={issues}
        dragDisabled
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Change status for Plan board UX' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Move Plan board UX to Doing' }));
    });

    expect(onStatusChange).toHaveBeenCalledWith('issue-1', 'doing');
  });

  it('deletes an issue via in-place confirmation', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete issue Plan board UX' }));
    });
    expect(screen.getByRole('button', { name: 'Confirm deleting Plan board UX' })).toHaveTextContent('Delete?');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Confirm deleting Plan board UX' }));
    });

    await waitFor(() => {
      expect(onDeleteIssue).toHaveBeenCalledWith('issue-1');
    });
  });

  it('arms delete confirmation on first click without deleting', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete issue Plan board UX' }));
    });

    expect(onDeleteIssue).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Confirm deleting Plan board UX' })).toHaveTextContent('Delete?');
  });

  it('exits delete confirmation when clicking elsewhere in the same issue card', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete issue Plan board UX' }));
    });
    expect(screen.getByRole('button', { name: 'Confirm deleting Plan board UX' })).toHaveTextContent('Delete?');

    await act(async () => {
      fireEvent.pointerDown(screen.getByRole('heading', { name: 'Plan board UX' }));
    });

    expect(screen.queryByRole('button', { name: 'Confirm deleting Plan board UX' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete issue Plan board UX' })).toBeInTheDocument();
  });

  it('uses the shared sky token on todo status badge', () => {
    const todoIssues: Issue[] = [
      {
        ...issues[0],
        status: 'todo',
      },
    ];

    render(
      <IssueBoard
        issues={todoIssues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    const statusButton = screen.getByRole('button', { name: 'Change status for Plan board UX' });
    const expectedBadgeClasses = ISSUE_STATUS_BADGE_CLASSNAMES.todo.split(' ');
    for (const className of expectedBadgeClasses) {
      expect(statusButton).toHaveClass(className);
    }
  });

  it('calls onMoveIssue with the target status and midpoint position after drag end', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'issue-1' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-3' },
      });
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-3' },
      });
    });

    expect(onMoveIssue).toHaveBeenCalledWith('issue-1', 'doing', 3, {
      mode: 'anchors',
      anchors: {
        previousIssueId: 'issue-2',
        nextIssueId: 'issue-3',
      },
    });
  });

  it('reverts the optimistic drag state when the parent declines the move', async () => {
    onMoveIssue.mockResolvedValue(false);

    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'issue-1' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-3' },
      });
    });
    expect(screen.getByRole('heading', { name: /^Todo(?:\(\d+\))?$/ })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^Doing(?:\(\d+\))?$/ })).toBeInTheDocument();

    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-3' },
      });
    });

    expect(onMoveIssue).toHaveBeenCalledWith('issue-1', 'doing', 3, {
      mode: 'anchors',
      anchors: {
        previousIssueId: 'issue-2',
        nextIssueId: 'issue-3',
      },
    });
    expect(screen.getByRole('button', { name: 'Change status for Plan board UX' })).toBeInTheDocument();
  });

  it('calculates drag positions within the dragged issue project only', async () => {
    const mixedProjectIssues: Issue[] = [
      {
        id: 'issue-project-a-todo',
        projectId: 'project-a',
        title: 'Project A todo',
        status: 'todo',
        priority: 'P1',
        position: 0,
        createdAt: '2026-04-14T00:00:00.000Z',
      },
      {
        id: 'issue-project-b-doing',
        projectId: 'project-b',
        title: 'Project B doing',
        status: 'doing',
        priority: 'P1',
        position: 2,
        createdAt: '2026-04-14T00:05:00.000Z',
      },
      {
        id: 'issue-project-a-doing',
        projectId: 'project-a',
        title: 'Project A doing',
        status: 'doing',
        priority: 'P1',
        position: 4,
        createdAt: '2026-04-14T00:10:00.000Z',
      },
    ];

    render(
      <IssueBoard
        issues={mixedProjectIssues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'issue-project-a-todo' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.({
        active: { id: 'issue-project-a-todo' },
        over: { id: 'issue-project-b-doing' },
      });
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({
        active: { id: 'issue-project-a-todo' },
        over: { id: 'issue-project-b-doing' },
      });
    });

    expect(onMoveIssue).toHaveBeenCalledWith('issue-project-a-todo', 'doing', 3, {
      mode: 'anchors',
      anchors: {
        previousIssueId: null,
        nextIssueId: 'issue-project-a-doing',
      },
    });
  });

  it('preserves the trailing anchor when dragging to the end of a column', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'issue-1' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.({
        active: { id: 'issue-1' },
        over: { id: 'doing' },
      });
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({
        active: { id: 'issue-1' },
        over: { id: 'doing' },
      });
    });

    expect(onMoveIssue).toHaveBeenCalledWith('issue-1', 'doing', 5, {
      mode: 'anchors',
      anchors: {
        previousIssueId: 'issue-3',
        nextIssueId: null,
      },
    });
  });

  it('does not call onMoveIssue when the issue is dropped onto itself', async () => {
    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'issue-1' } });
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-1' },
      });
    });

    expect(onMoveIssue).not.toHaveBeenCalled();
  });

  it('keeps the card in target column after drop before async move finishes', async () => {
    let resolveMove: ((value?: void | PromiseLike<void>) => void) | null = null;
    onMoveIssue.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveMove = resolve;
    }));

    render(
      <IssueBoard
        issues={issues}
        onMoveIssue={onMoveIssue}
        onStatusChange={onStatusChange}
        onDeleteIssue={onDeleteIssue}
      />,
    );

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'issue-1' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-3' },
      });
    });
    await act(async () => {
      void latestDndContextProps?.onDragEnd?.({
        active: { id: 'issue-1' },
        over: { id: 'issue-3' },
      });
    });

    const todoColumn = document.querySelector('[data-status-column="todo"]');
    const doingColumn = document.querySelector('[data-status-column="doing"]');
    expect(todoColumn?.querySelector('[data-issue-id="issue-1"]')).toBeNull();
    expect(doingColumn?.querySelector('[data-issue-id="issue-1"]')).toBeInTheDocument();
  });
});

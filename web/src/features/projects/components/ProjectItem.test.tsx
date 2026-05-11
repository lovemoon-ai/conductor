import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectItem } from './ProjectItem';

const pushMock = vi.fn();
const updateProjectMock = vi.fn();
const deleteProjectMock = vi.fn();
const deleteProjectGroupMock = vi.fn();
const hideProjectGroupMock = vi.fn();
const unhideProjectGroupMock = vi.fn();
const startProjectCollaborationMock = vi.fn();
const leaveCollaborationMock = vi.fn();
const pushToastMock = vi.fn();
const confirmMock = vi.fn();
const writeTextMock = vi.fn();
const sortableListeners = vi.hoisted(() => ({
  onPointerDown: vi.fn(),
  onMouseDown: vi.fn(),
  onTouchStart: vi.fn(),
  onKeyDown: vi.fn(),
}));

let agentsState = {
  agents: [] as Array<{ id: string; host: string }>,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('../store', () => ({
  useProjectsStore: () => ({
    updateProject: updateProjectMock,
    deleteProject: deleteProjectMock,
    deleteProjectGroup: deleteProjectGroupMock,
    hideProjectGroup: hideProjectGroupMock,
    unhideProjectGroup: unhideProjectGroupMock,
    startProjectCollaboration: startProjectCollaborationMock,
    leaveCollaboration: leaveCollaborationMock,
  }),
}));

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/shared/hooks/useSwipeActions', () => ({
  useSwipeActions: () => ({
    isOpen: false,
    panelStyle: { touchAction: 'pan-y' },
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onPointerCancel: vi.fn(),
    closeActions: vi.fn(),
    consumeTap: () => false,
  }),
}));

vi.mock('@dnd-kit/sortable', () => ({
  useSortable: () => ({
    attributes: {},
    listeners: sortableListeners,
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({
    confirm: confirmMock,
  }),
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

describe('ProjectItem', () => {
  beforeEach(() => {
    pushMock.mockReset();
    updateProjectMock.mockReset();
    deleteProjectMock.mockReset();
    deleteProjectGroupMock.mockReset();
    hideProjectGroupMock.mockReset();
    unhideProjectGroupMock.mockReset();
    startProjectCollaborationMock.mockReset();
    leaveCollaborationMock.mockReset();
    pushToastMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    writeTextMock.mockReset();
    writeTextMock.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: writeTextMock,
      },
    });
    sortableListeners.onPointerDown.mockReset();
    sortableListeners.onMouseDown.mockReset();
    sortableListeners.onTouchStart.mockReset();
    sortableListeners.onKeyDown.mockReset();
    agentsState = {
      agents: [],
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows offline state for bound projects when daemon is offline', () => {
    agentsState = {
      agents: [
        { id: 'daemon-1', host: 'daemon-online' },
      ],
    };

    render(
      <ProjectItem
        project={{
          id: 'project-1',
          name: 'Bound Project',
          daemonHost: 'daemon-offline',
          workspacePath: '/repo/bound',
          repoRoot: '/repo',
        } as any}
      />,
    );

    expect(screen.getByText('git')).toBeInTheDocument();
    expect(screen.getByText('daemon-offline')).toBeInTheDocument();
    expect(screen.getByText('Daemon offline')).toBeInTheDocument();
  });

  it('shows collaboration member count on shared project cards even when the daemon is offline', () => {
    render(
      <ProjectItem
        project={{
          id: 'project-shared',
          name: 'Shared Project',
          daemonHost: 'daemon-offline',
          collaborationId: 'collab-1',
          collaboration: {
            id: 'collab-1',
            inviteToken: 'invite-token',
            memberCount: 2,
            maxMembers: 5,
            members: [
              { id: 'member-1', userId: 'user-1', projectId: 'project-shared', label: 'User 1' },
              { id: 'member-2', userId: 'user-2', projectId: 'project-other', label: 'User 2' },
            ],
          },
        } as any}
      />,
    );

    expect(screen.getByText('Daemon offline')).toBeInTheDocument();
    expect(screen.getByText('2/5 members')).toBeInTheDocument();
  });

  it('creates and copies an invite link from the swipe action for unshared projects', async () => {
    startProjectCollaborationMock.mockResolvedValue({
      id: 'collab-new',
      inviteToken: 'invite-token',
      inviteUrl: 'http://localhost:6152/app/invite/invite-token',
      memberCount: 1,
      maxMembers: 5,
      members: [],
    });

    const { container } = render(
      <ProjectItem
        project={{
          id: 'project-invite',
          name: 'Invite Project',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull();

    const inviteButton = container.querySelector('button[aria-label="Invite project"]');
    expect(inviteButton).not.toBeNull();

    fireEvent.click(inviteButton!);

    await waitFor(() => {
      expect(startProjectCollaborationMock).toHaveBeenCalledWith('project-invite');
    });
    expect(writeTextMock).toHaveBeenCalledWith('http://localhost:6152/app/invite/invite-token');
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Invite link copied',
      description: '1/5 members joined.',
      variant: 'success',
    });
  });

  it('copies an existing invite from the same Invite swipe action', async () => {
    const { container } = render(
      <ProjectItem
        project={{
          id: 'project-shared-solo',
          name: 'Shared Solo',
          daemonHost: 'daemon-online',
          collaborationId: 'collab-solo',
          collaboration: {
            id: 'collab-solo',
            inviteToken: 'invite-token-solo',
            inviteUrl: 'http://localhost:6152/app/invite/invite-token-solo',
            memberCount: 1,
            maxMembers: 5,
            members: [
              { id: 'member-1', userId: 'user-1', projectId: 'project-shared-solo', label: 'User 1' },
            ],
          },
        } as any}
      />,
    );

    expect(screen.getByText('1/5 members')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy invite' })).toBeNull();
    expect(container.querySelector('button[aria-label="Leave collaboration"]')).toBeNull();

    const inviteButton = container.querySelector('button[aria-label="Invite project"]');
    expect(inviteButton).not.toBeNull();

    fireEvent.click(inviteButton!);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('http://localhost:6152/app/invite/invite-token-solo');
    });
    expect(startProjectCollaborationMock).not.toHaveBeenCalled();
  });

  it('shows the leave swipe action only after another member joins', async () => {
    const { container } = render(
      <ProjectItem
        project={{
          id: 'project-shared-actions',
          name: 'Shared Actions',
          daemonHost: 'daemon-online',
          collaborationId: 'collab-actions',
          collaboration: {
            id: 'collab-actions',
            inviteToken: 'invite-token-actions',
            inviteUrl: 'http://localhost:6152/app/invite/invite-token-actions',
            memberCount: 2,
            maxMembers: 5,
            members: [
              { id: 'member-1', userId: 'user-1', projectId: 'project-shared-actions', label: 'User 1' },
              { id: 'member-2', userId: 'user-2', projectId: 'project-other', label: 'User 2' },
            ],
          },
        } as any}
      />,
    );

    expect(screen.getByText('2/5 members')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy invite' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Leave' })).toBeNull();

    const inviteButton = container.querySelector('button[aria-label="Invite project"]');
    const leaveButton = container.querySelector('button[aria-label="Leave collaboration"]');
    expect(inviteButton).not.toBeNull();
    expect(leaveButton).not.toBeNull();

    fireEvent.click(inviteButton!);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith('http://localhost:6152/app/invite/invite-token-actions');
    });
    expect(startProjectCollaborationMock).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(inviteButton).not.toBeDisabled();
    });

    fireEvent.click(leaveButton!);

    await waitFor(() => {
      expect(confirmMock).toHaveBeenCalledWith({
        title: 'Leave collaboration?',
        description: 'This project will stop sharing its issue board with the other members.',
        confirmLabel: 'Leave',
        tone: 'danger',
      });
    });
    expect(leaveCollaborationMock).toHaveBeenCalledWith('collab-actions');
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Left collaboration',
      variant: 'success',
    });
  });

  it('shows candidate binding details for pending projects', () => {
    render(
      <ProjectItem
        project={{
          id: 'project-pending',
          name: 'Pending Project',
          metadata: {
            bindingCandidate: {
              daemonHost: 'daemon-a',
              workspacePath: '/repo/pending',
            },
          },
        } as any}
      />,
    );

    expect(screen.getByText('Binding pending')).toBeInTheDocument();
    expect(screen.getByText('daemon-a')).toBeInTheDocument();
    expect(screen.queryByText('git')).toBeNull();
  });

  it('selects a project on click instead of navigating immediately', () => {
    const onSelect = vi.fn();

    render(
      <ProjectItem
        project={{
          id: 'project-select',
          name: 'Selectable Project',
          daemonHost: 'daemon-online',
        } as any}
        isSelected
        onSelect={onSelect}
      />,
    );

    const card = screen.getByRole('button', { name: /Selectable Project/i });
    expect(card).toHaveClass('webapp-card-list-pane-active');
    expect(card).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(card);

    expect(onSelect).toHaveBeenCalledWith('project-select');
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('hides a project from the swipe action', () => {
    const onHide = vi.fn();

    const { container } = render(
      <ProjectItem
        project={{
          id: 'project-hide',
          name: 'Hide Project',
          daemonHost: 'daemon-online',
        } as any}
        onHide={onHide}
      />,
    );

    const hideButton = container.querySelector('button[aria-label="Hide project"]');
    expect(hideButton).not.toBeNull();

    fireEvent.click(hideButton!);

    expect(onHide).toHaveBeenCalledWith('project-hide');
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Project hidden',
      description: 'Double-click Projects to show hidden projects.',
    });
  });

  it('marks hidden projects and restores them from the swipe action', () => {
    const onUnhide = vi.fn();
    const { container } = render(
      <ProjectItem
        project={{
          id: 'project-hidden',
          name: 'Hidden Project',
          daemonHost: 'daemon-online',
        } as any}
        isHidden
        onHide={vi.fn()}
        onUnhide={onUnhide}
      />,
    );

    // Hidden projects render the folder icon with a dashed stroke instead of a "Hidden" tag.
    expect(container.querySelector('path[stroke-dasharray]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Hide project"]')).toBeNull();

    const showButton = container.querySelector('button[aria-label="Show project"]');
    expect(showButton).not.toBeNull();

    fireEvent.click(showButton!);

    expect(onUnhide).toHaveBeenCalledWith('project-hidden');
    expect(pushToastMock).toHaveBeenCalledWith({
      title: 'Project restored',
    });
  });

  it('renames a project inline after long pressing the title', async () => {
    vi.useFakeTimers();
    updateProjectMock.mockResolvedValue({
      id: 'project-rename',
      name: 'Renamed Project',
      daemonHost: 'daemon-online',
    });

    render(
      <ProjectItem
        project={{
          id: 'project-rename',
          name: 'Rename Me',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    fireEvent.pointerDown(screen.getByText('Rename Me'), { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    vi.useRealTimers();

    const input = screen.getByDisplayValue('Rename Me');
    fireEvent.change(input, { target: { value: 'Renamed Project' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      expect(updateProjectMock).toHaveBeenCalledWith('project-rename', { name: 'Renamed Project' });
    });
    expect(screen.queryByRole('button', { name: /Rename project/i })).toBeNull();
  });

  it('does not enter inline rename after a quick title tap', () => {
    vi.useFakeTimers();

    render(
      <ProjectItem
        project={{
          id: 'project-quick-tap',
          name: 'Quick Tap',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    const title = screen.getByText('Quick Tap');
    const card = title.closest('[role="button"]');
    expect(card).not.toBeNull();

    fireEvent.pointerDown(title, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(card!, { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.queryByDisplayValue('Quick Tap')).toBeNull();
  });

  it('starts sortable drag from the folder icon handle', () => {
    render(
      <ProjectItem
        project={{
          id: 'project-drag',
          name: 'Drag Project',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    const dragHandle = screen.getByLabelText('Drag project');
    fireEvent.mouseDown(dragHandle);
    fireEvent.touchStart(dragHandle);

    expect(sortableListeners.onMouseDown).toHaveBeenCalledTimes(1);
    expect(sortableListeners.onTouchStart).toHaveBeenCalledTimes(1);
  });

  it('keeps mobile vertical scrolling available outside the drag handle', () => {
    const { container } = render(
      <ProjectItem
        project={{
          id: 'project-scroll',
          name: 'Scrollable Project',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    const sortableWrapper = container.firstElementChild as HTMLElement | null;
    const card = screen.getByRole('button', { name: /Scrollable Project/i });
    const dragHandle = screen.getByLabelText('Drag project');

    expect(sortableWrapper).not.toBeNull();
    expect(sortableWrapper).not.toHaveStyle({ touchAction: 'none' });
    expect(card).toHaveStyle({ touchAction: 'pan-y' });
    expect(dragHandle).toHaveStyle({ touchAction: 'none' });
  });

  it('does not start sortable drag from the project card body', () => {
    render(
      <ProjectItem
        project={{
          id: 'project-body',
          name: 'Body Project',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    const card = screen.getByRole('button', { name: /Body Project/i });
    fireEvent.mouseDown(card);
    fireEvent.touchStart(card);

    expect(sortableListeners.onMouseDown).not.toHaveBeenCalled();
    expect(sortableListeners.onTouchStart).not.toHaveBeenCalled();
  });

  it('does not select the project when tapping the folder drag handle', () => {
    const onSelect = vi.fn();

    render(
      <ProjectItem
        project={{
          id: 'project-handle',
          name: 'Handle Project',
          daemonHost: 'daemon-online',
        } as any}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByLabelText('Drag project'));

    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not start sortable drag from the rename title area', () => {
    render(
      <ProjectItem
        project={{
          id: 'project-title',
          name: 'Title Project',
          daemonHost: 'daemon-online',
        } as any}
      />,
    );

    const title = screen.getByText('Title Project');
    fireEvent.mouseDown(title);
    fireEvent.touchStart(title);

    expect(sortableListeners.onMouseDown).not.toHaveBeenCalled();
    expect(sortableListeners.onTouchStart).not.toHaveBeenCalled();
  });

  describe('merged cross-daemon group', () => {
    const mergedMembers = [
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

    it('renders one daemon badge per member with online dot when daemon is online', () => {
      agentsState = {
        agents: [
          { id: 'a', host: 'daemon-a' },
          { id: 'b', host: 'daemon-b' },
        ],
      };
      render(
        <ProjectItem
          project={mergedMembers[0] as any}
          mergedMembers={mergedMembers as any}
          sortableId="merged:Alpha:p-a|p-b"
        />,
      );
      // Both daemon hosts surface as their own chips.
      expect(screen.getByText('daemon-a')).toBeInTheDocument();
      expect(screen.getByText('daemon-b')).toBeInTheDocument();
      // Group summary chip ("merged · 2 daemons") is rendered.
      expect(screen.getByText(/merged · 2 daemons/i)).toBeInTheDocument();
      // The single-mode "Daemon offline" / "Binding pending" chips MUST NOT
      // render under merged mode — those are per-card states.
      expect(screen.queryByText('Daemon offline')).toBeNull();
    });

    it('fans out hide to every member via hideProjectGroup', () => {
      render(
        <ProjectItem
          project={mergedMembers[0] as any}
          mergedMembers={mergedMembers as any}
          isSelected={false}
          isHidden={false}
          // onHide is supplied because canHide depends on it; the merged path
          // should bypass it and call hideProjectGroup instead.
          onHide={vi.fn()}
        />,
      );
      // Hide is invoked via the swipe action button. Find it by aria-label.
      fireEvent.click(screen.getByLabelText('Hide project'));

      expect(hideProjectGroupMock).toHaveBeenCalledWith(['p-a', 'p-b']);
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Merged project hidden across daemons',
        }),
      );
    });

    it('aggregates running task counts across all members', () => {
      const membersWithCounts = [
        {
          ...mergedMembers[0],
          taskStatusCounts: { running: 2, killed: 0 },
        },
        {
          ...mergedMembers[1],
          taskStatusCounts: { running: 3, killed: 1 },
        },
      ];
      render(
        <ProjectItem
          project={membersWithCounts[0] as any}
          mergedMembers={membersWithCounts as any}
        />,
      );
      // 2 + 3 = 5 running.
      expect(screen.getByText(/5 running/)).toBeInTheDocument();
      // 0 + 1 = 1 killed.
      expect(screen.getByText(/1 killed/)).toBeInTheDocument();
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProjectItem } from './ProjectItem';

const pushMock = vi.fn();
const updateProjectMock = vi.fn();
const deleteProjectMock = vi.fn();
const pushToastMock = vi.fn();
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
  }),
}));

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/shared/hooks/useSwipeActions', () => ({
  useSwipeActions: () => ({
    isOpen: false,
    panelStyle: {},
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
    confirm: vi.fn(),
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
    pushToastMock.mockReset();
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

    expect(screen.getByText('Hidden')).toBeInTheDocument();
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
});

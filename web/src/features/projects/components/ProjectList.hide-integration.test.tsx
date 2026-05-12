import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectList } from './ProjectList';
import { useProjectsStore } from '../store';

/**
 * Integration regression for the BUG-002 QA observation: after the user clicks
 * "Hide project" on a card, the hidden card must not stay in the list when
 * "show hidden" is OFF. The unit suite for the store and the unit suite for
 * `ProjectList` both pass on their own, but the QA round saw the card linger
 * — this file wires the *actual* store to the *actual* `ProjectList` so we
 * lock in the end-to-end behavior.
 */

const mockPatch = vi.fn();
const mockGet = vi.fn();
const mockPost = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
  }),
}));

let agentsState = { agents: [] as Array<{ id: string; host: string }> };
vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class {},
  TouchSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  closestCenter: () => [],
  pointerWithin: () => [],
}));

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
}));

vi.mock('@dnd-kit/utilities', () => ({
  CSS: { Transform: { toString: () => undefined } },
}));

vi.mock('./ProjectItem', () => ({
  ProjectItem: ({
    project,
    isHidden = false,
  }: { project: { id: string; name: string }; isHidden?: boolean }) => (
    <div
      data-testid={`project-item-${project.id}`}
      data-project-id={project.id}
      data-hidden={isHidden ? 'true' : 'false'}
    >
      {project.name}
    </div>
  ),
}));

const seedProject = (overrides: Partial<{
  id: string;
  name: string;
  hidden: boolean;
  isDefault: boolean;
  daemonHost: string | null;
}>) => ({
  id: overrides.id ?? 'project-1',
  name: overrides.name ?? 'Project One',
  hidden: overrides.hidden ?? false,
  isDefault: overrides.isDefault ?? false,
  daemonHost: overrides.daemonHost ?? null,
  workspacePath: null,
  repoRoot: null,
  worktreeBranch: null,
  lastCommit: null,
  fileCount: null,
  sortOrder: null,
  metadata: null,
});

const flushAsync = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('ProjectList × store (hide round-trip regression)', () => {
  beforeEach(() => {
    mockPatch.mockReset();
    mockGet.mockReset();
    mockPost.mockReset();
    mockDelete.mockReset();
    window.localStorage.clear();
    // Reset store state inside `act` so subscribed components flush without
    // emitting the React "update not wrapped in act" warning. The reset must
    // run before render, not as a teardown.
    act(() => {
      useProjectsStore.setState({
        projects: [],
        isLoading: false,
        error: null,
        selectedProjectId: null,
        hiddenProjectIds: [],
        showHiddenProjects: false,
      });
    });
    agentsState = { agents: [] };
  });

  it('removes a card from the list when the store hideProject action runs (showHidden=false)', async () => {
    const visible = seedProject({ id: 'project-visible', name: 'Visible Project' });
    const target = seedProject({ id: 'project-to-hide', name: 'Hide Me' });
    act(() => {
      useProjectsStore.setState({
        projects: [visible, target],
        showHiddenProjects: false,
      });
    });
    mockPatch.mockResolvedValueOnce({ ...target, hidden: true });

    render(<ProjectList />);

    expect(screen.getByTestId('project-item-project-to-hide')).toBeInTheDocument();

    await act(async () => {
      useProjectsStore.getState().hideProject('project-to-hide');
    });

    expect(useProjectsStore.getState().showHiddenProjects).toBe(false);
    expect(useProjectsStore.getState().hiddenProjectIds).toContain('project-to-hide');
    // The actual production filter: hidden id + showHidden=false must hide the card.
    expect(screen.queryByTestId('project-item-project-to-hide')).toBeNull();
    expect(screen.getByTestId('project-item-project-visible')).toBeInTheDocument();

    await flushAsync();
  });

  it('keeps the card visible when showHidden flips back to true (e.g. user toggled it)', async () => {
    const target = seedProject({ id: 'project-to-hide', name: 'Hide Me' });
    act(() => {
      useProjectsStore.setState({
        projects: [target],
        showHiddenProjects: false,
      });
    });
    mockPatch.mockResolvedValueOnce({ ...target, hidden: true });

    render(<ProjectList />);

    await act(async () => {
      useProjectsStore.getState().hideProject('project-to-hide');
    });
    // Card is gone.
    expect(screen.queryByTestId('project-item-project-to-hide')).toBeNull();

    await act(async () => {
      useProjectsStore.getState().toggleShowHiddenProjects();
    });
    // After re-enabling "show hidden", the card comes back.
    expect(useProjectsStore.getState().showHiddenProjects).toBe(true);
    expect(screen.getByTestId('project-item-project-to-hide')).toBeInTheDocument();
    expect(screen.getByTestId('project-item-project-to-hide')).toHaveAttribute('data-hidden', 'true');

    await flushAsync();
  });

  it('does NOT render a card that the API returns as hidden:true even if the optimistic path was never taken', async () => {
    // Reflects the post-PATCH state: the server says the project is hidden,
    // the store fetches it via fetchProjects, and the list applies the same
    // filter to the freshly-loaded data.
    const target = seedProject({ id: 'project-already-hidden', name: 'Already Hidden', hidden: true });
    act(() => {
      useProjectsStore.setState({
        projects: [target],
        hiddenProjectIds: ['project-already-hidden'],
        showHiddenProjects: false,
      });
    });

    render(<ProjectList />);

    expect(screen.queryByTestId('project-item-project-already-hidden')).toBeNull();
    expect(screen.getByText('No visible projects')).toBeInTheDocument();
  });
});

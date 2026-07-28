import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/shared/types';
import { ProjectList } from './ProjectList';

const setSelectedProjectIdMock = vi.fn();
const reorderProjectsMock = vi.fn();
const hideProjectMock = vi.fn();
const unhideProjectMock = vi.fn();
const hydrateMock = vi.fn();
const saveScopeMock = vi.fn(async () => true);

let latestDndContextProps: Record<string, any> | null = null;

let projectsState = {
  projects: [] as Project[],
  isLoading: false,
  selectedProjectId: null as string | null,
  hiddenProjectIds: [] as string[],
  showHiddenProjects: false,
  setSelectedProjectId: setSelectedProjectIdMock,
  hideProject: hideProjectMock,
  unhideProject: unhideProjectMock,
  reorderProjects: reorderProjectsMock,
};

let agentsState = { agents: [] as Array<{ id: string; host: string }> };

let authState = {
  session: { user: { id: 'user-1' } } as { user: { id: string } } | null,
};

let syncState = {
  snapshot: { version: 1 as const, revision: 0, scopes: {} as Record<string, unknown[]> },
  hydrated: true,
  loading: false,
  error: null as string | null,
  hydrate: hydrateMock,
  saveScope: saveScopeMock,
};

vi.mock('../store', () => ({ useProjectsStore: () => projectsState }));
vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));
vi.mock('@/features/auth/store', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}));
vi.mock('../project-card-groups-sync-store', () => ({
  useProjectCardGroupsSyncStore: (selector: (state: typeof syncState) => unknown) => selector(syncState),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, ...props }: { children: React.ReactNode }) => {
    latestDndContextProps = props;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class MouseSensor {},
  TouchSensor: class TouchSensor {},
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
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
    aggregation,
  }: {
    project: Project;
    aggregation?: { id: string; tabs: unknown[] };
  }) => (
    <div
      data-project-id={project.id}
      data-testid={aggregation ? `aggregation-${aggregation.id}` : `project-item-${project.id}`}
      data-tab-count={aggregation ? aggregation.tabs.length : 0}
    >
      {project.name}
    </div>
  ),
}));

const threeProjects: Project[] = [
  { id: 'p1', name: 'P1' } as Project,
  { id: 'p2', name: 'P2' } as Project,
  { id: 'p3', name: 'P3' } as Project,
];

// The production code decides aggregate-vs-reorder from the LIVE POINTER
// position (activatorEvent.clientY + accumulated delta.y) measured against the
// target row wrapper's real getBoundingClientRect — NOT the dragged card's
// dnd-kit translated box (which the sortable strategy displaces mid-drag). We
// stub every wrapper rect to {top:0,height:100} in beforeEach, so a pointer at
// `ratio * 100` lands at `ratio` down the target card.
const overEvent = (activeId: string, overId: string, ratio: number) => ({
  active: { id: activeId },
  over: { id: overId },
  activatorEvent: { clientY: ratio * 100 },
  delta: { y: 0 },
});

describe('ProjectList aggregation drag', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Row wrappers have no layout in jsdom (all zeros), so the pointer-band math
    // can't run. Give every element a stable 100px-tall rect anchored at top 0,
    // matching the pointer coordinates the overEvent helper feeds in.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    latestDndContextProps = null;
    projectsState = {
      ...projectsState,
      projects: threeProjects,
      isLoading: false,
    };
    agentsState = { agents: [] };
    authState = { session: { user: { id: 'user-1' } } };
    syncState = {
      ...syncState,
      snapshot: { version: 1, revision: 0, scopes: {} },
      hydrated: true,
      hydrate: hydrateMock,
      saveScope: saveScopeMock,
    };
  });

  it('aggregates and persists when a card is dropped on the middle of another', async () => {
    const { container } = render(<ProjectList />);

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'p2' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.(overEvent('p2', 'p1', 0.5));
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({ active: { id: 'p2' }, over: { id: 'p1' } });
    });

    expect(saveScopeMock).toHaveBeenCalledWith(
      'user-1',
      'projects:all',
      expect.arrayContaining([expect.objectContaining({ projectIds: ['p1', 'p2'] })]),
    );
    expect(reorderProjectsMock).not.toHaveBeenCalled();
    // A single aggregation card with two tabs now stands in for p1 + p2.
    const aggCard = container.querySelector('[data-testid^="aggregation-"]');
    expect(aggCard?.getAttribute('data-tab-count')).toBe('2');
  });

  it('does not aggregate when dropped near a card edge (outer band)', async () => {
    const { container } = render(<ProjectList />);

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'p2' } });
    });
    await act(async () => {
      // ratio 0.05 → outer band → reorder, not aggregate.
      latestDndContextProps?.onDragOver?.(overEvent('p2', 'p1', 0.05));
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({ active: { id: 'p2' }, over: { id: 'p1' } });
    });

    // No aggregation is created and nothing is persisted to the sync scope.
    expect(saveScopeMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid^="aggregation-"]')).toBeNull();
  });

  it('does not aggregate before the snapshot has hydrated', async () => {
    syncState = { ...syncState, hydrated: false };
    render(<ProjectList />);

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'p2' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragOver?.(overEvent('p2', 'p1', 0.5));
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({ active: { id: 'p2' }, over: { id: 'p1' } });
    });

    expect(saveScopeMock).not.toHaveBeenCalled();
  });

  it('does not aggregate onto a stale target when the final drop is over a different card', async () => {
    render(<ProjectList />);

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'p2' } });
    });
    await act(async () => {
      // Highlighted p1 as the aggregate target...
      latestDndContextProps?.onDragOver?.(overEvent('p2', 'p1', 0.5));
    });
    await act(async () => {
      // ...but released over p3.
      await latestDndContextProps?.onDragEnd?.({ active: { id: 'p2' }, over: { id: 'p3' } });
    });

    expect(saveScopeMock).not.toHaveBeenCalled();
  });
});

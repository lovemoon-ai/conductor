import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@/shared/types';
import { ProjectList } from './ProjectList';

const setSelectedProjectIdMock = vi.fn();
const reorderProjectsMock = vi.fn();
const hideProjectMock = vi.fn();
const unhideProjectMock = vi.fn();

let latestDndContextProps: Record<string, any> | null = null;
let latestSensorOptions: Array<{ name: string; options: Record<string, any> }> = [];
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

let agentsState = {
  agents: [] as Array<{ id: string; host: string }>,
};

vi.mock('../store', () => ({
  useProjectsStore: () => projectsState,
}));

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({ children, ...props }: { children: React.ReactNode }) => {
    latestDndContextProps = props;
    return <div>{children}</div>;
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  MouseSensor: class MouseSensor {},
  TouchSensor: class TouchSensor {},
  useSensor: (sensor: { name?: string }, options: Record<string, any>) => {
    latestSensorOptions.push({ name: sensor.name ?? 'unknown', options });
    return {};
  },
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
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

vi.mock('./ProjectItem', () => ({
  ProjectItem: ({
    project,
    isHidden = false,
    onHide,
    onUnhide,
  }: {
    project: Project;
    isHidden?: boolean;
    onHide?: (projectId: string) => void;
    onUnhide?: (projectId: string) => void;
  }) => (
    <div data-hidden={isHidden ? 'true' : 'false'} data-project-id={project.id} data-testid={`project-item-${project.id}`}>
      {project.name}
      <button type="button" onClick={() => onHide?.(project.id)}>hide {project.name}</button>
      <button type="button" onClick={() => onUnhide?.(project.id)}>show {project.name}</button>
    </div>
  ),
}));

vi.mock('./project-list-utils', () => ({
  reorderProjectsLocally: (projects: Project[], activeId: string, overId: string) => {
    const activeIndex = projects.findIndex((project) => project.id === activeId);
    const overIndex = projects.findIndex((project) => project.id === overId);
    if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
      return projects;
    }
    const next = [...projects];
    const [moved] = next.splice(activeIndex, 1);
    next.splice(overIndex, 0, moved);
    return next;
  },
  reorderProjectGroupsLocally: (
    groups: Array<{ key: string; members: Project[] }>,
    activeId: string,
    overId: string,
  ) => {
    const activeIndex = groups.findIndex((group) => group.key === activeId);
    const overIndex = groups.findIndex((group) => group.key === overId);
    if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
      return groups;
    }
    const next = [...groups];
    const [moved] = next.splice(activeIndex, 1);
    next.splice(overIndex, 0, moved);
    return next;
  },
  flattenGroupsToProjectIds: (groups: Array<{ members: Project[] }>) => {
    const out: string[] = [];
    for (const group of groups) {
      for (const member of group.members) out.push(member.id);
    }
    return out;
  },
}));

describe('ProjectList', () => {
  beforeEach(() => {
    latestDndContextProps = null;
    latestSensorOptions = [];
    setSelectedProjectIdMock.mockReset();
    reorderProjectsMock.mockReset();
    hideProjectMock.mockReset();
    unhideProjectMock.mockReset();
  });

  it('requires long press only for touch project dragging', () => {
    projectsState = {
      projects: [
        { id: 'project-a', name: 'Project A' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    expect(latestSensorOptions).toEqual([
      {
        name: 'MouseSensor',
        options: {
          activationConstraint: {
            distance: 6,
          },
        },
      },
      {
        name: 'TouchSensor',
        options: {
          activationConstraint: {
            delay: 350,
            tolerance: 8,
          },
        },
      },
    ]);
  });

  it('shows projects bound to offline daemons', () => {
    projectsState = {
      projects: [
        { id: 'default-project', name: 'Default Project', isDefault: true },
        { id: 'online-project', name: 'Online Project', daemonHost: 'daemon-online' },
        { id: 'offline-project', name: 'Offline Project', daemonHost: 'daemon-offline' },
        { id: 'legacy-project', name: 'Legacy Project' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [{ id: 'agent-1', host: 'daemon-online' }],
    };

    render(<ProjectList />);

    expect(screen.getByText('Default Project')).toBeInTheDocument();
    expect(screen.getByText('Online Project')).toBeInTheDocument();
    expect(screen.getByText('Offline Project')).toBeInTheDocument();
    expect(screen.getByText('Legacy Project')).toBeInTheDocument();
  });

  it('keeps shared and offline daemon projects visible', () => {
    projectsState = {
      projects: [
        { id: 'offline-project', name: 'Offline Project', daemonHost: 'daemon-offline' },
        {
          id: 'shared-project',
          name: 'Shared Project',
          daemonHost: 'daemon-offline',
          collaborationId: 'collab-1',
          collaboration: {
            id: 'collab-1',
            inviteToken: 'invite-token',
            memberCount: 2,
            maxMembers: 5,
            members: [],
          },
        },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [],
    };

    render(<ProjectList />);

    expect(screen.getByText('Shared Project')).toBeInTheDocument();
    expect(screen.getByText('Offline Project')).toBeInTheDocument();
  });

  it('hides stale solo collaboration duplicates when the same workspace has a shared collaboration', () => {
    projectsState = {
      projects: [
        {
          id: 'solo-collaboration',
          name: 'conductor',
          daemonHost: 'qa-daemon-2',
          workspacePath: '/Users/duino/ws/conductor',
          collaborationId: 'solo-collab',
          collaboration: {
            id: 'solo-collab',
            inviteToken: 'solo-token',
            memberCount: 1,
            maxMembers: 5,
            members: [],
          },
        },
        {
          id: 'shared-collaboration',
          name: 'conductor',
          daemonHost: 'debug',
          workspacePath: '/Users/duino/ws/conductor',
          collaborationId: 'shared-collab',
          collaboration: {
            id: 'shared-collab',
            inviteToken: 'shared-token',
            memberCount: 2,
            maxMembers: 5,
            members: [],
          },
        },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [],
    };

    render(<ProjectList />);

    expect(screen.getByTestId('project-item-shared-collaboration')).toBeInTheDocument();
    expect(screen.queryByTestId('project-item-solo-collaboration')).toBeNull();
  });

  it('shows offline daemon projects instead of an empty state', () => {
    projectsState = {
      projects: [
        { id: 'offline-project', name: 'Offline Project', daemonHost: 'daemon-offline' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [],
    };

    render(<ProjectList />);

    expect(screen.getByText('Offline Project')).toBeInTheDocument();
    expect(screen.queryByText('No online projects')).toBeNull();
    expect(screen.queryByText('Reconnect a daemon to show its projects')).toBeNull();
  });

  it('keeps offline daemon projects in the submitted order when visible projects are dragged', async () => {
    reorderProjectsMock.mockResolvedValue(undefined);
    projectsState = {
      projects: [
        { id: 'online-a', name: 'Online A', daemonHost: 'daemon-online' },
        { id: 'offline-b', name: 'Offline B', daemonHost: 'daemon-offline' },
        { id: 'online-c', name: 'Online C', daemonHost: 'daemon-online' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [{ id: 'agent-1', host: 'daemon-online' }],
    };

    render(<ProjectList />);

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'online-c' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragMove?.({ active: { id: 'online-c' }, over: { id: 'online-a' } });
    });
    await act(async () => {
      render(<ProjectList />);
    });
    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({ active: { id: 'online-c' }, over: { id: 'online-a' } });
    });

    expect(reorderProjectsMock).toHaveBeenCalledWith(['online-c', 'online-a', 'offline-b']);
  });

  it('keeps rows stable while dragging and reorders them on drop', async () => {
    projectsState = {
      projects: [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
        { id: 'project-c', name: 'Project C' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    await act(async () => {
      latestDndContextProps?.onDragStart?.({ active: { id: 'project-a' } });
    });
    await act(async () => {
      latestDndContextProps?.onDragMove?.({ active: { id: 'project-a' }, over: { id: 'project-c' } });
    });

    const renderedIdsWhileDragging = screen
      .getAllByTestId(/project-item-/)
      .slice(0, 3)
      .map((item) => item.getAttribute('data-project-id'));
    expect(renderedIdsWhileDragging).toEqual(['project-a', 'project-b', 'project-c']);

    await act(async () => {
      await latestDndContextProps?.onDragEnd?.({
        active: { id: 'project-a' },
        over: { id: 'project-c' },
      });
    });

    const renderedIdsAfterDrop = screen
      .getAllByTestId(/project-item-/)
      .slice(0, 3)
      .map((item) => item.getAttribute('data-project-id'));
    expect(renderedIdsAfterDrop).toEqual(['project-b', 'project-c', 'project-a']);
    expect(reorderProjectsMock).toHaveBeenCalledWith(['project-b', 'project-c', 'project-a']);
  });

  it('hides locally hidden project cards until hidden projects are shown', () => {
    projectsState = {
      projects: [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: ['project-b'],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    expect(screen.getByText('Project A')).toBeInTheDocument();
    expect(screen.queryByText('Project B')).toBeNull();
  });

  it('shows hidden project cards when hidden visibility is enabled', () => {
    projectsState = {
      projects: [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: ['project-b'],
      showHiddenProjects: true,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    expect(screen.getByTestId('project-item-project-b')).toHaveAttribute('data-hidden', 'true');
  });

  it('passes project hide actions to project items', () => {
    projectsState = {
      projects: [
        { id: 'project-hide', name: 'Project Hide' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    screen.getByRole('button', { name: 'hide Project Hide' }).click();

    expect(hideProjectMock).toHaveBeenCalledWith('project-hide');
  });

  it('passes project show actions to hidden project items', () => {
    projectsState = {
      projects: [
        { id: 'project-show', name: 'Project Show' },
      ],
      isLoading: false,
      selectedProjectId: null,
      hiddenProjectIds: ['project-show'],
      showHiddenProjects: true,
      setSelectedProjectId: setSelectedProjectIdMock,
      hideProject: hideProjectMock,
      unhideProject: unhideProjectMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    screen.getByRole('button', { name: 'show Project Show' }).click();

    expect(unhideProjectMock).toHaveBeenCalledWith('project-show');
  });
});

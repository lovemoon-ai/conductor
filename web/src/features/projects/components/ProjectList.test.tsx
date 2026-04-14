import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Project } from '@/shared/types';
import { ProjectList } from './ProjectList';

const setSelectedProjectIdMock = vi.fn();
const reorderProjectsMock = vi.fn();

let projectsState = {
  projects: [] as Project[],
  isLoading: false,
  selectedProjectId: null as string | null,
  setSelectedProjectId: setSelectedProjectIdMock,
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

vi.mock('./ProjectItem', () => ({
  ProjectItem: ({ project, dragHandle }: { project: Project; dragHandle?: ReactNode }) => (
    <div data-testid={`project-item-${project.id}`}>
      {dragHandle}
      <span>{project.name}</span>
    </div>
  ),
}));

describe('ProjectList', () => {
  beforeEach(() => {
    setSelectedProjectIdMock.mockReset();
    reorderProjectsMock.mockReset();
  });

  it('hides projects bound to offline daemons', () => {
    projectsState = {
      projects: [
        { id: 'default-project', name: 'Default Project', isDefault: true },
        { id: 'online-project', name: 'Online Project', daemonHost: 'daemon-online' },
        { id: 'offline-project', name: 'Offline Project', daemonHost: 'daemon-offline' },
        { id: 'legacy-project', name: 'Legacy Project' },
      ],
      isLoading: false,
      selectedProjectId: null,
      setSelectedProjectId: setSelectedProjectIdMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [{ id: 'agent-1', host: 'daemon-online' }],
    };

    render(<ProjectList />);

    expect(screen.getByText('Default Project')).toBeInTheDocument();
    expect(screen.getByText('Online Project')).toBeInTheDocument();
    expect(screen.getByText('Legacy Project')).toBeInTheDocument();
    expect(screen.queryByText('Offline Project')).toBeNull();
  });

  it('shows an online-projects empty state when only offline daemon projects exist', () => {
    projectsState = {
      projects: [
        { id: 'offline-project', name: 'Offline Project', daemonHost: 'daemon-offline' },
      ],
      isLoading: false,
      selectedProjectId: null,
      setSelectedProjectId: setSelectedProjectIdMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [],
    };

    render(<ProjectList />);

    expect(screen.getByText('No online projects')).toBeInTheDocument();
    expect(screen.getByText('Reconnect a daemon to show its projects')).toBeInTheDocument();
    expect(screen.queryByText('Offline Project')).toBeNull();
  });

  it('keeps hidden offline projects in the submitted order when visible projects are dragged', () => {
    projectsState = {
      projects: [
        { id: 'online-a', name: 'Online A', daemonHost: 'daemon-online' },
        { id: 'offline-b', name: 'Offline B', daemonHost: 'daemon-offline' },
        { id: 'online-c', name: 'Online C', daemonHost: 'daemon-online' },
      ],
      isLoading: false,
      selectedProjectId: null,
      setSelectedProjectId: setSelectedProjectIdMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = {
      agents: [{ id: 'agent-1', host: 'daemon-online' }],
    };

    render(<ProjectList />);

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };
    const dragHandles = screen.getAllByLabelText('Drag to reorder');
    fireEvent.dragStart(dragHandles[1], { dataTransfer });
    fireEvent.drop(screen.getByTestId('project-item-online-a').parentElement!, { dataTransfer });

    expect(reorderProjectsMock).toHaveBeenCalledWith(['online-c', 'offline-b', 'online-a']);
  });

  it('allows dragging a visible project after the last visible project', () => {
    projectsState = {
      projects: [
        { id: 'project-a', name: 'Project A' },
        { id: 'project-b', name: 'Project B' },
        { id: 'project-c', name: 'Project C' },
      ],
      isLoading: false,
      selectedProjectId: null,
      setSelectedProjectId: setSelectedProjectIdMock,
      reorderProjects: reorderProjectsMock,
    };
    agentsState = { agents: [] };

    render(<ProjectList />);

    const dataTransfer = {
      data: {} as Record<string, string>,
      effectAllowed: '',
      dropEffect: '',
      setData(type: string, value: string) {
        this.data[type] = value;
      },
      getData(type: string) {
        return this.data[type] ?? '';
      },
    };
    fireEvent.dragStart(screen.getAllByLabelText('Drag to reorder')[0], { dataTransfer });
    fireEvent.drop(screen.getByTestId('project-list-end-dropzone'), { dataTransfer });

    expect(reorderProjectsMock).toHaveBeenCalledWith(['project-b', 'project-c', 'project-a']);
  });
});

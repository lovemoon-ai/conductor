import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Project } from '@/shared/types';
import { ProjectList } from './ProjectList';

const setSelectedProjectIdMock = vi.fn();

let projectsState = {
  projects: [] as Project[],
  isLoading: false,
  selectedProjectId: null as string | null,
  setSelectedProjectId: setSelectedProjectIdMock,
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
  ProjectItem: ({ project }: { project: Project }) => <div>{project.name}</div>,
}));

describe('ProjectList', () => {
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
    };
    agentsState = {
      agents: [],
    };

    render(<ProjectList />);

    expect(screen.getByText('No online projects')).toBeInTheDocument();
    expect(screen.getByText('Reconnect a daemon to show its projects')).toBeInTheDocument();
    expect(screen.queryByText('Offline Project')).toBeNull();
  });
});

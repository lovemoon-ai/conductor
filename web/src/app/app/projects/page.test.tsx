import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import ProjectsPage from './page';

const fetchProjectsMock = vi.fn();
const refreshProjectMock = vi.fn();
const setSelectedProjectIdMock = vi.fn();
const toggleShowHiddenProjectsMock = vi.fn();

const projectPageState = vi.hoisted(() => ({
  isLoading: false,
  showHiddenProjects: false,
  projects: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/features/projects', () => {
  const getProjectsStoreSnapshot = () => ({
    fetchProjects: fetchProjectsMock,
    refreshProject: refreshProjectMock,
    projects: projectPageState.projects,
    isLoading: projectPageState.isLoading,
    setSelectedProjectId: setSelectedProjectIdMock,
    showHiddenProjects: projectPageState.showHiddenProjects,
    toggleShowHiddenProjects: toggleShowHiddenProjectsMock,
  });
  const useProjectsStore = Object.assign(
    (selector: (state: {
      fetchProjects: typeof fetchProjectsMock;
      refreshProject: typeof refreshProjectMock;
      projects: typeof projectPageState.projects;
      isLoading: boolean;
      setSelectedProjectId: typeof setSelectedProjectIdMock;
      showHiddenProjects: boolean;
      toggleShowHiddenProjects: typeof toggleShowHiddenProjectsMock;
    }) => unknown) => selector(getProjectsStoreSnapshot()),
    { getState: getProjectsStoreSnapshot },
  );
  return {
    useProjectsStore,
    ProjectList: () => <div>project-list</div>,
    CreateProjectDialog: ({ open }: { open: boolean }) => (open ? <div>create-project-dialog</div> : null),
  };
});

vi.mock('@/features/tasks', () => ({
  RefreshIcon: ({ spinning = false }: { spinning?: boolean }) => (
    <span>{spinning ? 'spinning' : 'refresh'}</span>
  ),
}));

vi.mock('@/components/layout/Header', () => ({
  Header: ({
    title,
    actions,
    onTitleClick,
    onTitleDoubleClick,
    titleDoubleClickHint,
  }: {
    title?: string;
    actions?: ReactNode;
    onTitleClick?: () => void;
    onTitleDoubleClick?: () => void;
    titleDoubleClickHint?: string;
  }) => (
    <div>
      <h1 onClick={onTitleClick} onDoubleClick={onTitleDoubleClick} title={titleDoubleClickHint}>
        {title}
      </h1>
      <div>{actions}</div>
    </div>
  ),
}));

describe('ProjectsPage', () => {
  beforeEach(() => {
    projectPageState.isLoading = false;
    projectPageState.showHiddenProjects = false;
    projectPageState.projects = [];
    fetchProjectsMock.mockReset();
    fetchProjectsMock.mockResolvedValue(undefined);
    refreshProjectMock.mockReset();
    refreshProjectMock.mockResolvedValue({});
    setSelectedProjectIdMock.mockReset();
    toggleShowHiddenProjectsMock.mockReset();
  });

  it('clears the selected project when clicking the Projects title', () => {
    render(<ProjectsPage />);

    fireEvent.click(screen.getByRole('heading', { name: 'Projects' }));

    expect(setSelectedProjectIdMock).toHaveBeenCalledWith(null);
  });

  it('toggles hidden project visibility when double-clicking the Projects title', () => {
    render(<ProjectsPage />);

    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Projects' }));

    expect(toggleShowHiddenProjectsMock).toHaveBeenCalledTimes(1);
  });

  it('refreshes daemon-bound projects from the latest top bar fetch result', async () => {
    const fetchedProjects = [
      { id: 'project-bound', daemonHost: 'daemon-a', workspacePath: '/repo/a' },
      { id: 'project-default', daemonHost: null, workspacePath: null },
      { id: 'project-unbound', daemonHost: 'daemon-b', workspacePath: null },
    ];
    projectPageState.projects = [];
    fetchProjectsMock.mockImplementation(async () => {
      projectPageState.projects = fetchedProjects;
    });

    render(<ProjectsPage />);
    fetchProjectsMock.mockClear();
    projectPageState.projects = [];

    fireEvent.click(screen.getByRole('button', { name: 'Refresh projects' }));

    await waitFor(() => {
      expect(refreshProjectMock).toHaveBeenCalledWith('project-bound');
    });
    expect(refreshProjectMock).toHaveBeenCalledTimes(1);
    expect(fetchProjectsMock).toHaveBeenCalledTimes(2);
  });
});

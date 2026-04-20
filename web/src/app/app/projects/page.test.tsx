import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import ProjectsPage from './page';

const fetchProjectsMock = vi.fn();
const setSelectedProjectIdMock = vi.fn();
const toggleShowHiddenProjectsMock = vi.fn();

let isLoading = false;
let showHiddenProjects = false;

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: {
    fetchProjects: typeof fetchProjectsMock;
    isLoading: boolean;
    setSelectedProjectId: typeof setSelectedProjectIdMock;
    showHiddenProjects: boolean;
    toggleShowHiddenProjects: typeof toggleShowHiddenProjectsMock;
  }) => unknown) =>
    selector({
      fetchProjects: fetchProjectsMock,
      isLoading,
      setSelectedProjectId: setSelectedProjectIdMock,
      showHiddenProjects,
      toggleShowHiddenProjects: toggleShowHiddenProjectsMock,
    }),
  ProjectList: () => <div>project-list</div>,
  CreateProjectDialog: ({ open }: { open: boolean }) => (open ? <div>create-project-dialog</div> : null),
}));

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
    isLoading = false;
    showHiddenProjects = false;
    fetchProjectsMock.mockReset();
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
});

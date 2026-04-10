import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import ProjectsPage from './page';

const fetchProjectsMock = vi.fn();
const setSelectedProjectIdMock = vi.fn();

let isLoading = false;

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: {
    fetchProjects: typeof fetchProjectsMock;
    isLoading: boolean;
    setSelectedProjectId: typeof setSelectedProjectIdMock;
  }) => unknown) =>
    selector({
      fetchProjects: fetchProjectsMock,
      isLoading,
      setSelectedProjectId: setSelectedProjectIdMock,
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
    onTitleDoubleClick,
    titleDoubleClickHint,
  }: {
    title?: string;
    actions?: ReactNode;
    onTitleDoubleClick?: () => void;
    titleDoubleClickHint?: string;
  }) => (
    <div>
      <h1 onDoubleClick={onTitleDoubleClick} title={titleDoubleClickHint}>
        {title}
      </h1>
      <div>{actions}</div>
    </div>
  ),
}));

describe('ProjectsPage', () => {
  beforeEach(() => {
    isLoading = false;
    fetchProjectsMock.mockReset();
    setSelectedProjectIdMock.mockReset();
  });

  it('clears the selected project when double-clicking the Projects title', () => {
    render(<ProjectsPage />);

    fireEvent.doubleClick(screen.getByRole('heading', { name: 'Projects' }));

    expect(setSelectedProjectIdMock).toHaveBeenCalledWith(null);
  });
});

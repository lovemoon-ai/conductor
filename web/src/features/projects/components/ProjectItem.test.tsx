import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ProjectItem } from './ProjectItem';

const pushMock = vi.fn();
const updateProjectMock = vi.fn();
const deleteProjectMock = vi.fn();
const pushToastMock = vi.fn();

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

vi.mock('@/components/common/FeedbackProvider', () => ({
  useConfirm: () => ({
    confirm: vi.fn(),
  }),
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

describe('ProjectItem', () => {
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
});

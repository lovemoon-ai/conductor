import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(screen.queryByText('git')).toBeNull();
  });
});

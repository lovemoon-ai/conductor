import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CreateProjectDialog } from './CreateProjectDialog';

const createProjectMock = vi.fn();
let agentsState = {
  agents: [
    { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['codex'], capabilities: [] },
  ],
};

vi.mock('../common/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('@/lib/conductor/stores/projects', () => ({
  useProjectsStore: (selector: (state: { createProject: typeof createProjectMock }) => unknown) =>
    selector({ createProject: createProjectMock }),
}));

vi.mock('@/lib/conductor/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

describe('CreateProjectDialog', () => {
  beforeEach(() => {
    createProjectMock.mockReset();
    agentsState = {
      agents: [
        { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['codex'], capabilities: [] },
      ],
    };
  });

  it('submits a binding candidate for later daemon confirmation', async () => {
    createProjectMock.mockResolvedValueOnce({ id: 'project-1' });
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    expect(screen.getByText('Choose an online daemon or type another host. The daemon or CLI confirms the workspace binding later.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Project name'), {
      target: { value: 'Alpha Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('Select or enter daemon host'), {
      target: { value: 'daemon-a' },
    });
    fireEvent.change(screen.getByPlaceholderText('Optional description'), {
      target: { value: 'Demo description' },
    });
    fireEvent.change(screen.getByPlaceholderText('Local path, e.g. /Users/you/ws/project'), {
      target: { value: '/repo/alpha' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'Alpha Project',
        description: 'Demo description',
        metadata: {
          bindingCandidate: {
            daemonHost: 'daemon-a',
            workspacePath: '/repo/alpha',
          },
        },
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('allows staging a pending project when no daemon is online', async () => {
    agentsState = { agents: [] };
    createProjectMock.mockResolvedValueOnce({ id: 'project-offline' });
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    expect(screen.getByText('No daemon is online. Enter the daemon host manually; the daemon or CLI confirms the workspace binding later.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Project name'), {
      target: { value: 'Offline Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter daemon host manually'), {
      target: { value: 'daemon-offline' },
    });
    fireEvent.change(screen.getByPlaceholderText('Local path, e.g. /Users/you/ws/project'), {
      target: { value: '/repo/offline' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'Offline Project',
        description: undefined,
        metadata: {
          bindingCandidate: {
            daemonHost: 'daemon-offline',
            workspacePath: '/repo/offline',
          },
        },
      });
    });
    expect(onClose).toHaveBeenCalled();
  });
});

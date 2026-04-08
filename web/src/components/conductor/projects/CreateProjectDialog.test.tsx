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

  it('submits daemonHost and workspacePath for immediate validation', async () => {
    createProjectMock.mockResolvedValueOnce({ id: 'project-1' });
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    expect(screen.getByText('Choose an online daemon. Conductor validates the workspace path immediately before creating the project.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Project name'), {
      target: { value: 'Alpha Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('Select an online daemon'), {
      target: { value: 'daemon-a' },
    });
    fireEvent.change(screen.getByPlaceholderText('Local path, e.g. /Users/you/ws/project'), {
      target: { value: '/repo/alpha' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'Alpha Project',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/alpha',
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('disables project creation when no daemon is online', async () => {
    agentsState = { agents: [] };
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    expect(screen.getByText('No daemon is online. Reconnect conductor daemon before creating a bound project.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Project name'), {
      target: { value: 'Offline Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('Local path, e.g. /Users/you/ws/project'), {
      target: { value: '/repo/offline' },
    });

    expect(screen.getByRole('button', { name: 'Create Project' })).toBeDisabled();
    expect(createProjectMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

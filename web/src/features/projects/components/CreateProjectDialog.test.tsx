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

vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../store', () => ({
  useProjectsStore: (selector: (state: { createProject: typeof createProjectMock }) => unknown) =>
    selector({ createProject: createProjectMock }),
}));

vi.mock('@/features/agents', () => ({
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
    fireEvent.change(screen.getByRole('combobox'), {
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

  it('creates project with binding candidate when daemon is offline', async () => {
    agentsState = { agents: [] };
    createProjectMock.mockResolvedValueOnce({ id: 'project-offline' });
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    expect(screen.getByText('No daemon is online. Reconnect conductor daemon before creating a bound project.')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Project name'), {
      target: { value: 'Offline Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('Reconnect a daemon first'), {
      target: { value: 'daemon-offline' },
    });
    fireEvent.change(screen.getByPlaceholderText('Local path, e.g. /Users/you/ws/project'), {
      target: { value: '/repo/offline' },
    });

    expect(screen.getByRole('button', { name: 'Create Project' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'Offline Project',
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

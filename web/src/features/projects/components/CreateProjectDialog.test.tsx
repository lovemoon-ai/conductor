import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { ApiRequestError } from '@/shared/api/client';
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

    const { container } = render(<CreateProjectDialog open onClose={onClose} />);

    expect(
      Array.from(container.querySelectorAll('label')).map((label) => label.textContent?.trim()),
    ).toEqual(['Daemon Host', 'Workspace Path', 'Name']);
    expect(screen.queryByText('Enter host manually')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Daemon Host')).toHaveValue('daemon-a'));

    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/alpha' },
    });
    expect(screen.getByLabelText('Name')).toHaveValue('alpha');

    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Alpha Project' },
    });
    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/beta' },
    });
    expect(screen.getByLabelText('Name')).toHaveValue('Alpha Project');

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'Alpha Project',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/beta',
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('creates project with binding candidate when daemon is offline', async () => {
    agentsState = { agents: [] };
    createProjectMock.mockResolvedValueOnce({ id: 'project-offline' });
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Daemon Host'), {
      target: { value: 'daemon-offline' },
    });
    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/offline' },
    });

    expect(screen.getByRole('button', { name: 'Create Project' })).not.toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'offline',
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

  it('offers to create the workspace directory when the daemon reports it missing', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiRequestError(400, {
        error: 'Workspace path does not exist on daemon daemon-a: /repo/fresh',
        code: 'workspace_not_found',
      }),
    );
    const onClose = vi.fn();

    render(<CreateProjectDialog open onClose={onClose} />);

    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/fresh' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    // First attempt must not create anything on disk.
    await waitFor(() => {
      expect(createProjectMock).toHaveBeenCalledWith({
        name: 'fresh',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/fresh',
      });
    });
    expect(onClose).not.toHaveBeenCalled();

    const retry = await screen.findByRole('button', {
      name: 'Create this directory and continue',
    });
    createProjectMock.mockResolvedValueOnce({ id: 'project-fresh' });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(createProjectMock).toHaveBeenLastCalledWith({
        name: 'fresh',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/fresh',
        createWorkspaceIfMissing: true,
      });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('hides the create-directory prompt once the path is edited', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiRequestError(400, { error: 'missing', code: 'workspace_not_found' }),
    );

    render(<CreateProjectDialog open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/typo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await screen.findByRole('button', { name: 'Create this directory and continue' });

    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/correct' },
    });

    expect(
      screen.queryByRole('button', { name: 'Create this directory and continue' }),
    ).not.toBeInTheDocument();
  });

  it('hides the create-directory prompt when the daemon is switched', async () => {
    agentsState = {
      agents: [
        { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['codex'], capabilities: [] },
        { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['codex'], capabilities: [] },
      ],
    };
    createProjectMock.mockRejectedValueOnce(
      new ApiRequestError(400, { error: 'missing', code: 'workspace_not_found' }),
    );

    render(<CreateProjectDialog open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/only-on-a' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await screen.findByRole('button', { name: 'Create this directory and continue' });

    // The "missing" verdict came from daemon-a; it says nothing about daemon-b.
    fireEvent.change(screen.getByLabelText('Daemon Host'), {
      target: { value: 'daemon-b' },
    });

    expect(
      screen.queryByRole('button', { name: 'Create this directory and continue' }),
    ).not.toBeInTheDocument();
  });

  it('does not offer directory creation for unrelated failures', async () => {
    createProjectMock.mockRejectedValueOnce(
      new ApiRequestError(409, { error: 'Daemon offline', code: 'daemon_offline' }),
    );

    render(<CreateProjectDialog open onClose={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('Workspace Path'), {
      target: { value: '/repo/alpha' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() => expect(createProjectMock).toHaveBeenCalled());
    expect(
      screen.queryByRole('button', { name: 'Create this directory and continue' }),
    ).not.toBeInTheDocument();
  });
});

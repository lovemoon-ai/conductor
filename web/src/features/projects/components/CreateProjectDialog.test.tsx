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
});

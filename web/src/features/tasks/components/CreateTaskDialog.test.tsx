import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';
import { ApiRequestError } from '@/shared/api/client';

const pushMock = vi.fn();
const createTaskMock = vi.fn();
const onCreatedTaskMock = vi.fn();

let projectsState: any = {
  projects: [
    { id: 'project-1', name: 'Project One', isDefault: true },
    { id: 'project-2', name: 'Project Two' },
  ],
};

const agentsState = {
  agents: [
    { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude', 'codex'], capabilities: ['pty_task'] },
    { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: [] },
    { id: 'fire-1', host: 'conductor-fire-worker', supportedBackends: ['fire'], capabilities: [] },
  ],
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
  }),
}));

vi.mock('@/components/common/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('../store', () => ({
  useTasksStore: (selector: (state: { createTask: typeof createTaskMock }) => unknown) =>
    selector({ createTask: createTaskMock }),
}));

vi.mock('@/features/projects', async () => {
  const actual = await vi.importActual<typeof import('@/features/projects')>('@/features/projects');
  return {
    ...actual,
    useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
  };
});

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    pushMock.mockReset();
    onCreatedTaskMock.mockReset();
    vi.restoreAllMocks();
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One', isDefault: true },
        { id: 'project-2', name: 'Project Two' },
      ],
    };
  });

  it('uses first option as default and reveals guidance only after clicking help', async () => {
    render(<CreateTaskDialog open onClose={() => {}} />);

    const selects = await screen.findAllByRole('combobox');
    expect(selects).toHaveLength(3);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);

    const [projectSelect, daemonSelect, backendSelect] = selects;
    const [aiTaskRadio, ptyTaskRadio] = radios;

    await waitFor(() => {
      expect(projectSelect).toHaveValue('project-1');
      expect(daemonSelect).toHaveValue('daemon-a');
      expect(backendSelect).toHaveValue('claude');
      expect(aiTaskRadio).toBeChecked();
      expect(ptyTaskRadio).not.toBeChecked();
    });

    expect(within(projectSelect).queryByRole('option', { name: 'No project' })).toBeNull();
    expect(within(daemonSelect).queryByRole('option', { name: 'Auto-select daemon' })).toBeNull();
    expect(within(backendSelect).queryByRole('option', { name: 'Default' })).toBeNull();
    expect(screen.queryByLabelText('worktree')).toBeNull();
    expect(screen.queryByText('Conversation-first task routed through the AI runner. The selected project fixes the daemon, and backend choices come from that daemon.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show help for AI Task' }));
    expect(screen.getByText('Conversation-first task routed through the AI runner. The selected project fixes the daemon, and backend choices come from that daemon.')).toBeInTheDocument();
  });

  it('defaults to the current project when provided', async () => {
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One', isDefault: true },
        { id: 'project-bound', name: 'Bound Project', daemonHost: 'daemon-b', workspacePath: '/repo/bound' },
      ],
    };

    render(<CreateTaskDialog open onClose={() => {}} defaultProjectId="project-bound" />);

    const projectSelect = await screen.findByLabelText('Project');
    await waitFor(() => {
      expect(projectSelect).toHaveValue('project-bound');
    });
  });

  it('creates pty_task with a shell launchConfig only', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-pty-1' });

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.click(screen.getByRole('radio', { name: /PTY Task/ }));
    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Open a codex terminal' },
    });
    expect(screen.getByRole('radio', { name: /PTY Task/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /AI Task/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Create PTY Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith({
        title: 'Open a codex terminal',
        projectId: 'project-1',
        taskType: 'pty_task',
        agentHost: 'daemon-a',
        backendType: undefined,
        launchConfig: {
          entrypointType: 'shell',
        },
      });
    });
    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-pty-1');
    expect(screen.queryByLabelText('Terminal Entrypoint')).toBeNull();
    expect(screen.queryByLabelText('Shell Path')).toBeNull();
    expect(screen.queryByLabelText('Working Directory')).toBeNull();
    expect(screen.queryByLabelText('worktree')).toBeNull();
  });

  it('uses inline selection callback when provided after task creation', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-inline-1' });

    render(<CreateTaskDialog open onClose={() => {}} onCreatedTask={onCreatedTaskMock} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Open inline detail' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(onCreatedTaskMock).toHaveBeenCalledWith('task-inline-1');
    });
    expect(pushMock).not.toHaveBeenCalled();
  });

  it('shows worktree for git projects and submits the checkbox state', async () => {
    projectsState = {
      projects: [
        {
          id: 'project-git',
          name: 'Git Project',
          daemonHost: 'daemon-a',
          workspacePath: '/repo/app',
          repoRoot: '/repo',
        },
      ],
    };
    createTaskMock.mockResolvedValueOnce({ id: 'task-git-1' });

    render(<CreateTaskDialog open onClose={() => {}} />);

    expect(await screen.findByText('worktree')).toBeInTheDocument();
    const worktreeCheckbox = await screen.findByRole('checkbox');
    fireEvent.click(worktreeCheckbox);
    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Use isolated branch' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Use isolated branch',
        projectId: 'project-git',
        launchConfig: {
          worktree: true,
        },
      }));
    });
  });

  it('hides worktree when PTY task is selected even for git projects', async () => {
    projectsState = {
      projects: [
        {
          id: 'project-git',
          name: 'Git Project',
          daemonHost: 'daemon-a',
          workspacePath: '/repo/app',
          repoRoot: '/repo',
        },
      ],
    };

    render(<CreateTaskDialog open onClose={() => {}} />);

    expect(await screen.findByRole('checkbox')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: /PTY Task/ }));

    await waitFor(() => {
      expect(screen.queryByRole('checkbox')).toBeNull();
    });
  });

  it('locks the daemon to a bound project', async () => {
    projectsState = {
      projects: [
        {
          id: 'project-bound',
          name: 'Bound Project',
          daemonHost: 'daemon-b',
          workspacePath: '/repo/bound',
        },
      ],
    };
    createTaskMock.mockResolvedValueOnce({ id: 'task-bound-1' });

    render(<CreateTaskDialog open onClose={() => {}} />);

    const daemonSelect = await screen.findByLabelText('Daemon');
    await waitFor(() => {
      expect(daemonSelect).toHaveValue('daemon-b');
    });
    expect(daemonSelect).toBeDisabled();
    expect(screen.getByText('Bound to daemon-b : /repo/bound')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Use bound daemon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Use bound daemon',
        projectId: 'project-bound',
        agentHost: 'daemon-b',
      }));
    });
  });
});

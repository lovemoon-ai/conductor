import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';
import { ApiRequestError } from '@/shared/api/client';

const pushMock = vi.fn();
const createTaskMock = vi.fn();
const onCreatedTaskMock = vi.fn();
const { apiGetMock } = vi.hoisted(() => ({
  apiGetMock: vi.fn(),
}));

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

vi.mock('@/shared/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/api/client')>();
  return {
    ...actual,
    getApiClient: () => ({
      get: apiGetMock,
    }),
  };
});

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
    vi.restoreAllMocks();
    createTaskMock.mockReset();
    pushMock.mockReset();
    onCreatedTaskMock.mockReset();
    apiGetMock.mockReset();
    apiGetMock.mockResolvedValue({
      agents: [
        {
          name: 'feature-dev',
          description: 'Executes feature work',
          backend: null,
        },
        {
          name: 'code-reviewer',
          description: 'Reviews code changes',
          backend: 'codex',
        },
      ],
    });
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One', isDefault: true },
        { id: 'project-2', name: 'Project Two' },
      ],
    };
    agentsState.agents = [
      { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude', 'codex'], capabilities: ['pty_task'] },
      { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: [] },
      { id: 'fire-1', host: 'conductor-fire-worker', supportedBackends: ['fire'], capabilities: [] },
    ];
  });

  it('disables AI task creation when no daemon is online', async () => {
    agentsState.agents = [];

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Cannot dispatch yet' },
    });

    expect(screen.getByText(
      'No daemon is online right now. Reconnect conductor daemon before creating an AI task.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create AI Task' })).toBeDisabled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('uses first option as default and reveals guidance only after clicking help', async () => {
    render(<CreateTaskDialog open onClose={() => {}} />);

    await screen.findByLabelText('Worker agent');
    const selects = await screen.findAllByRole('combobox');
    expect(selects).toHaveLength(4);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);

    const [projectSelect, daemonSelect, backendSelect, workerAgentSelect] = selects;
    const [aiTaskRadio, ptyTaskRadio] = radios;

    await waitFor(() => {
      expect(projectSelect).toHaveValue('project-1');
      expect(daemonSelect).toHaveValue('daemon-a');
      expect(backendSelect).toHaveValue('claude');
      expect(workerAgentSelect).toHaveValue('');
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

  it('omits agents for a plain AI task (no worker agent named)', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-plain' });
    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Plain task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
    await waitFor(() => expect(createTaskMock).toHaveBeenCalled());
    expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('agents');
  });

  it('sends a worker + reviewer agents group with per-reviewer backend', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-group' });
    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Build with review' },
    });
    fireEvent.change(await screen.findByLabelText('Worker agent'), {
      target: { value: 'feature-dev' },
    });
    // Reviewer controls only appear once a worker agent is named.
    fireEvent.click(screen.getByRole('button', { name: '+ Add reviewer' }));
    fireEvent.change(screen.getByLabelText('Reviewer 1 agent'), {
      target: { value: 'code-reviewer' },
    });
    fireEvent.change(screen.getByLabelText('Reviewer 1 backend'), {
      target: { value: 'codex' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [
            { name: 'feature-dev' },
            { name: 'code-reviewer', backend: 'codex' },
          ],
        }),
      );
    });
  });

  // Without a prompt the worker's bootstrap is just "read your agent doc", so a
  // freshly created group has nothing to act on and sits idle. The dialog had
  // no prompt field at all, so the API's initial_content was never populated
  // from the UI.
  it('sends the prompt as initialContent so the group has something to start on', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-group-prompted' });
    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Build with review' },
    });
    fireEvent.change(screen.getByLabelText('Task prompt'), {
      target: { value: '  Add retries to the upload client.  ' },
    });
    fireEvent.change(await screen.findByLabelText('Worker agent'), {
      target: { value: 'feature-dev' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(
        expect.objectContaining({
          agents: [{ name: 'feature-dev' }],
          initialContent: 'Add retries to the upload client.',
        }),
      );
    });
  });

  // The prompt is offered for every AI task, not just groups: with no agent
  // group it is simply the task's opening message and the single agent runs it.
  it('sends the prompt for a plain AI task with no agent group', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-plain-prompted' });
    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Plain task' },
    });
    fireEvent.change(screen.getByLabelText('Task prompt'), {
      target: { value: 'Add retries to the upload client.' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalled();
    });
    const payload = createTaskMock.mock.calls[0][0];
    expect(payload.initialContent).toBe('Add retries to the upload client.');
    expect(payload).not.toHaveProperty('agents');
  });

  it('omits initialContent when the prompt is left empty', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-no-prompt' });
    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'No prompt' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalled();
    });
    expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('initialContent');
  });

  it('drops the group (no agents) when the worker agent is cleared', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-plain-after-clear' });
    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Needs worker' },
    });
    // Name a worker to reveal the reviewer control, add a reviewer, then clear the worker.
    const workerAgentSelect = await screen.findByLabelText('Worker agent');
    fireEvent.change(workerAgentSelect, {
      target: { value: 'feature-dev' },
    });
    fireEvent.click(screen.getByRole('button', { name: '+ Add reviewer' }));
    fireEvent.change(screen.getByLabelText('Reviewer 1 agent'), {
      target: { value: 'code-reviewer' },
    });
    fireEvent.change(workerAgentSelect, {
      target: { value: '' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    // Reviewer inputs are hidden once the worker name is cleared, so the group is
    // dropped and a normal task would be created — assert createTask is NOT called
    // with agents. (The submit still proceeds as a plain task.)
    await waitFor(() => expect(createTaskMock).toHaveBeenCalled());
    expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('agents');
  });

  it('shows the empty-registry guidance when settings.yaml has no agents', async () => {
    apiGetMock.mockResolvedValueOnce({ agents: [] });

    render(<CreateTaskDialog open onClose={() => {}} />);

    expect(
      await screen.findByText(/No agents registered for this project/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Worker agent')).toBeNull();
    expect(apiGetMock).toHaveBeenCalledWith('/projects/project-1/agents');
  });

  it('applies a registered worker backend default when the daemon advertises it', async () => {
    apiGetMock.mockResolvedValueOnce({
      agents: [
        {
          name: 'feature-dev',
          description: 'Executes feature work',
          backend: 'codex',
        },
      ],
    });

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(await screen.findByLabelText('Worker agent'), {
      target: { value: 'feature-dev' },
    });
    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
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

    const worktreeLabel = await screen.findByText('worktree');
    expect(worktreeLabel).toBeInTheDocument();
    const executionHeading = screen.getByRole('heading', { name: 'Execution' });
    expect(
      Boolean(executionHeading.compareDocumentPosition(worktreeLabel) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
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

  describe('cross-daemon merged group', () => {
    const mergedProjects = [
      {
        id: 'p-a',
        name: 'Alpha',
        daemonHost: 'daemon-a',
        workspacePath: '/repo/alpha',
        repoRoot: '/repo/alpha',
        gitRemoteUrl: 'github.com/foo/alpha',
      },
      {
        id: 'p-b',
        name: 'Alpha',
        daemonHost: 'daemon-b',
        workspacePath: '/repo/alpha',
        repoRoot: '/repo/alpha',
        gitRemoteUrl: 'github.com/foo/alpha',
      },
    ];

    it('renders one project entry per merged group, not one per daemon', async () => {
      projectsState = { projects: mergedProjects };
      render(<CreateTaskDialog open onClose={() => {}} />);

      const projectSelect = await screen.findByLabelText('Project');
      const options = within(projectSelect).getAllByRole('option');
      // Two same-name projects collapse to one option labeled with daemon count.
      expect(options).toHaveLength(1);
      expect(options[0]).toHaveTextContent(/Alpha \(2 daemons\)/);
    });

    it('uses the daemon dropdown to switch which member project receives the task', async () => {
      projectsState = { projects: mergedProjects };
      createTaskMock.mockResolvedValueOnce({ id: 'task-merged' });
      render(<CreateTaskDialog open onClose={() => {}} />);

      const daemonSelect = await screen.findByLabelText('Daemon');
      // The daemon dropdown lists each member's daemon and is enabled even
      // though the underlying member project is "bound".
      expect(daemonSelect).not.toBeDisabled();
      const daemonOptions = within(daemonSelect).getAllByRole('option');
      expect(daemonOptions.map((o) => o.textContent)).toEqual(['daemon-a', 'daemon-b']);

      // Default selection is the group's primary member (p-a / daemon-a).
      await waitFor(() => {
        expect((daemonSelect as HTMLSelectElement).value).toBe('p-a');
      });

      // Switch to daemon-b's underlying project.
      fireEvent.change(daemonSelect, { target: { value: 'p-b' } });

      fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
        target: { value: 'Run on daemon-b' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

      await waitFor(() => {
        expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
          title: 'Run on daemon-b',
          // Submission must target daemon-b's project (p-b), not the group's
          // primary (p-a).
          projectId: 'p-b',
          agentHost: 'daemon-b',
        }));
      });
    });
  });
});

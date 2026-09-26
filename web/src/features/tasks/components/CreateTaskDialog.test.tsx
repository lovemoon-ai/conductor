import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';
import { TERMINAL_TITLES } from '../utils/terminal-title';
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

vi.mock('@/features/auth', () => ({
  useAuthStore: (selector: (state: { session: { user: { id: string } } }) => unknown) =>
    selector({ session: { user: { id: 'draft-user' } } }),
}));

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
  Dialog: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    open ? <div>{children}{footer}</div> : null,
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

const globalBackendsState: {
  backends: Array<{ host: string; backend: string }>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
} = { backends: [], hydrated: true, hydrate: async () => {} };

vi.mock('@/features/user-preferences/global-ai-backends', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/user-preferences/global-ai-backends')>();
  return {
    ...actual,
    useGlobalAiBackendsStore: (selector: (state: typeof globalBackendsState) => unknown) =>
      selector(globalBackendsState),
  };
});

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
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
    globalBackendsState.backends = [];
  });


  it('saves the task prompt before device setup and restores it after remounting', async () => {
    agentsState.agents = [];
    const view = render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Keep these detailed instructions' } });
    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Mobile task' } });
    const link = screen.getByRole('link', { name: 'Manage devices' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    view.unmount();
    render(<CreateTaskDialog open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Task prompt')).toHaveValue('Keep these detailed instructions'));
    expect(screen.getByLabelText('Task title')).toHaveValue('Mobile task');
  });

  it('preserves advanced options through offline registry failure and clears the draft on success', async () => {
    projectsState.projects[0].repoRoot = '/repo';
    const draft = {
      title: 'Restore all options', initialContent: 'Implement the mobile fixes', projectId: 'project-1',
      createWorktree: true, persistent: false, remoteWorktreeHost: '', agentHost: 'daemon-a', backendType: 'codex',
      globalBackendKey: '', workerAgent: 'feature-dev', reviewers: [{ name: 'code-reviewer', backend: 'codex' }], submitError: null,
    };
    sessionStorage.setItem('conductor-create-task-draft:draft-user', JSON.stringify(draft));
    apiGetMock.mockRejectedValueOnce(new Error('Device offline'));
    const online = agentsState.agents;
    agentsState.agents = [];
    const view = render(<CreateTaskDialog open onClose={() => {}} />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    const link = screen.getByRole('link', { name: 'Manage devices' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(JSON.parse(sessionStorage.getItem('conductor-create-task-draft:draft-user')!)).toEqual(draft);
    view.unmount();
    agentsState.agents = online;
    createTaskMock.mockResolvedValueOnce({ id: 'restored-task' });
    render(<CreateTaskDialog open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Worker agent')).toHaveValue('feature-dev'));
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
    await waitFor(() => expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      title: draft.title, initialContent: draft.initialContent, projectId: 'project-1',
      backendType: 'codex', launchConfig: { worktree: true },
      agents: [{ name: 'feature-dev' }, { name: 'code-reviewer', backend: 'codex' }],
    })));
    expect(sessionStorage.getItem('conductor-create-task-draft:draft-user')).toBeNull();
  });

  it('discards the saved draft on explicit cancellation', async () => {
    agentsState.agents = [];
    const view = render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Cancelled draft' } });
    const link = screen.getByRole('link', { name: 'Manage devices' });
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sessionStorage.getItem('conductor-create-task-draft:draft-user')).toBeNull();
    view.unmount();
    render(<CreateTaskDialog open onClose={() => {}} />);
    expect(screen.getByLabelText('Task prompt')).toHaveValue('');
  });

  it('does not restore an archived (hidden) project from a saved draft', async () => {
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One', isDefault: true },
        { id: 'project-archived', name: 'Archived Project', daemonHost: 'daemon-a', workspacePath: '/repo/archived', hidden: true },
      ],
    };
    sessionStorage.setItem('conductor-create-task-draft:draft-user', JSON.stringify({
      title: 'Archived draft', initialContent: 'Continue the archived work', projectId: 'project-archived',
      taskType: 'ai_task', createWorktree: true, agentHost: 'daemon-a', backendType: 'codex',
      workerAgent: 'feature-dev', reviewers: [{ name: 'code-reviewer', backend: 'codex' }], submitError: null,
    }));

    render(<CreateTaskDialog open onClose={() => {}} />);

    await waitFor(() => expect(screen.getByLabelText('Task prompt')).toHaveValue('Continue the archived work'));
    expect(screen.getByLabelText('Project')).toHaveValue('project-1');
  });

  it('ignores malformed drafts and drafts belonging to another user', () => {
    sessionStorage.setItem('conductor-create-task-draft:draft-user', '{malformed');
    sessionStorage.setItem('conductor-create-task-draft:another-user', JSON.stringify({ initialContent: 'Private draft' }));
    render(<CreateTaskDialog open onClose={() => {}} />);
    expect(screen.getByLabelText('Task prompt')).toHaveValue('');
    expect(sessionStorage.getItem('conductor-create-task-draft:draft-user')).toBeNull();
  });

  it('keeps the user in the form if the device-setup draft cannot be saved', () => {
    agentsState.agents = [];
    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Do not lose this' } });
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    expect(fireEvent.click(screen.getByRole('link', { name: 'Manage devices' }))).toBe(false);
    expect(screen.getByLabelText('Task prompt')).toHaveValue('Do not lose this');
    expect(screen.getByText(/Unable to save your draft/)).toBeInTheDocument();
  });
  it('creates a task from instructions and derives a concise title without requiring advanced options', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-from-prompt' });
    render(<CreateTaskDialog open onClose={() => {}} />);
    const prompt = 'Improve the settings page.\nKeep device controls easy to find.';
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: prompt } });
    expect(screen.getByText('Advanced options').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
    await waitFor(() => expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Improve the settings',
      initialContent: prompt,
      projectId: 'project-1',
      agentHost: 'daemon-a',
    })));
  });

  it('disables AI task creation when no daemon is online', async () => {
    agentsState.agents = [];

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Cannot dispatch yet' },
    });

    expect(screen.getByText(
      'Connect a device to run this task. You can keep writing your instructions here.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create AI Task' })).toBeDisabled();
    expect(createTaskMock).not.toHaveBeenCalled();
  });

  it('uses first option as default and reveals guidance only after clicking help', async () => {
    render(<CreateTaskDialog open onClose={() => {}} />);

    await screen.findByLabelText('Worker agent');
    const selects = await screen.findAllByRole('combobox');
    expect(selects).toHaveLength(4);
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    const [projectSelect, daemonSelect, backendSelect, workerAgentSelect] = selects;

    await waitFor(() => {
      expect(projectSelect).toHaveValue('project-1');
      expect(daemonSelect).toHaveValue('daemon-a');
      expect(backendSelect).toHaveValue('claude');
      expect(workerAgentSelect).toHaveValue('');
    });

    expect(within(projectSelect).queryByRole('option', { name: 'No project' })).toBeNull();
    expect(within(daemonSelect).queryByRole('option', { name: 'Auto-select daemon' })).toBeNull();
    expect(within(backendSelect).queryByRole('option', { name: 'Default' })).toBeNull();
    expect(screen.queryByLabelText('worktree')).toBeNull();
    expect(screen.queryByText('The selected daemon defines which AI backends are available below.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show help for daemon' }));
    expect(screen.getByText('The selected daemon defines which AI backends are available below.')).toBeInTheDocument();
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

  it('omits archived (hidden) projects from the project picker', async () => {
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One', isDefault: true },
        { id: 'project-bound', name: 'Bound Project', daemonHost: 'daemon-b', workspacePath: '/repo/bound' },
        { id: 'project-archived', name: 'Archived Project', daemonHost: 'daemon-b', workspacePath: '/repo/archived', hidden: true },
      ],
    };

    render(<CreateTaskDialog open onClose={() => {}} />);

    const projectSelect = await screen.findByLabelText('Project');
    const optionLabels = within(projectSelect).getAllByRole('option').map((option) => option.textContent);
    expect(optionLabels).toEqual(expect.arrayContaining(['Project One', 'Bound Project']));
    expect(optionLabels.join(' ')).not.toContain('Archived Project');
  });

  it('falls back off an archived defaultProjectId instead of preselecting it', async () => {
    projectsState = {
      projects: [
        { id: 'project-1', name: 'Project One', isDefault: true },
        { id: 'project-archived', name: 'Archived Project', daemonHost: 'daemon-b', workspacePath: '/repo/archived', hidden: true },
      ],
    };

    render(<CreateTaskDialog open onClose={() => {}} defaultProjectId="project-archived" />);

    const projectSelect = await screen.findByLabelText('Project');
    await waitFor(() => {
      expect(projectSelect).toHaveValue('project-1');
    });
  });

  it('opens a terminal from the New Terminal tab with a constellation title and no project', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-pty-1' });

    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'New Terminal' }));

    // Only PTY-capable daemons are offered; the project defaults to none.
    const daemonSelect = screen.getByLabelText('Daemon');
    expect(within(daemonSelect).getAllByRole('option').map((option) => option.textContent)).toEqual(['daemon-a']);
    expect(screen.getByLabelText(/Project/)).toHaveValue('');
    expect(screen.queryByLabelText('Task title')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith({
        title: expect.any(String),
        projectId: 'project-1',
        taskType: 'pty_task',
        agentHost: 'daemon-a',
        launchConfig: { entrypointType: 'shell' },
      });
    });
    expect(TERMINAL_TITLES).toContain(createTaskMock.mock.calls[0][0].title);
    expect(pushMock).toHaveBeenCalledWith('/app/tasks/task-pty-1');
  });

  it('opens a terminal in a project bound to the chosen daemon', async () => {
    projectsState.projects.push(
      { id: 'project-a', name: 'Repo A', daemonHost: 'daemon-a', workspacePath: '/repo/a' },
      { id: 'project-b', name: 'Repo B', daemonHost: 'daemon-b', workspacePath: '/repo/b' },
    );
    createTaskMock.mockResolvedValueOnce({ id: 'task-pty-2' });

    render(<CreateTaskDialog open onClose={() => {}} onCreatedTask={onCreatedTaskMock} />);
    fireEvent.click(screen.getByRole('tab', { name: 'New Terminal' }));

    const projectSelect = screen.getByLabelText(/Project/);
    expect(within(projectSelect).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['None (home directory)', 'Repo A']);
    fireEvent.change(projectSelect, { target: { value: 'project-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-a',
        taskType: 'pty_task',
        agentHost: 'daemon-a',
      }));
    });
    expect(onCreatedTaskMock).toHaveBeenCalledWith('task-pty-2');
  });

  it('lists a bound default project under its daemon instead of offering a home-directory terminal', async () => {
    projectsState.projects = [
      { id: 'project-default', name: 'Bound Default', isDefault: true, daemonHost: 'daemon-a', workspacePath: '/repo/d' },
      { id: 'project-a', name: 'Repo A', daemonHost: 'daemon-a', workspacePath: '/repo/a' },
    ];
    createTaskMock.mockResolvedValueOnce({ id: 'task-pty-3' });

    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'New Terminal' }));

    const projectSelect = screen.getByLabelText(/Project/);
    expect(within(projectSelect).getAllByRole('option').map((option) => option.textContent))
      .toEqual(['Bound Default', 'Repo A']);
    expect(projectSelect).toHaveValue('project-default');
    expect(screen.getByText(/pick a project for this terminal/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'project-default',
        agentHost: 'daemon-a',
      }));
    });
  });

  it('cannot open a terminal on a daemon with no project when the default project is bound elsewhere', () => {
    projectsState.projects = [
      { id: 'project-default', name: 'Bound Default', isDefault: true, daemonHost: 'daemon-b', workspacePath: '/repo/d' },
    ];

    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'New Terminal' }));

    expect(within(screen.getByLabelText(/Project/)).queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No project on this daemon/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Terminal' })).toBeDisabled();
  });

  it('warns in the New Terminal tab when no PTY-capable daemon is online', () => {
    agentsState.agents = agentsState.agents.map((agent) => ({ ...agent, capabilities: [] }));

    render(<CreateTaskDialog open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: 'New Terminal' }));

    expect(screen.getByText('No terminal-capable daemon online')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open Terminal' })).toBeNull();
  });

  it('uses inline selection callback when provided after task creation', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-inline-1' });

    render(<CreateTaskDialog open onClose={() => {}} onCreatedTask={onCreatedTaskMock} />);

    fireEvent.change(screen.getByLabelText('Task title'), {
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
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Plain task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
    await waitFor(() => expect(createTaskMock).toHaveBeenCalled());
    expect(createTaskMock.mock.calls[0][0]).not.toHaveProperty('agents');
  });

  it('sends a worker + reviewer agents group with per-reviewer backend', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-group' });
    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText('Task title'), {
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

    fireEvent.change(screen.getByLabelText('Task title'), {
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

    fireEvent.change(screen.getByLabelText('Task title'), {
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

    fireEvent.change(screen.getByLabelText('Task title'), {
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
    fireEvent.change(screen.getByLabelText('Task title'), {
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
    expect(screen.getByLabelText('AI backend')).toHaveValue('codex');
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
    const executionHeading = screen.getByRole('heading', { name: 'Run on' });
    expect(
      Boolean(executionHeading.compareDocumentPosition(worktreeLabel) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
    const worktreeCheckbox = await screen.findByRole('checkbox', { name: 'Create task in a separate worktree' });
    fireEvent.click(worktreeCheckbox);
    fireEvent.change(screen.getByLabelText('Task title'), {
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

  it('submits a persistent task', async () => {
    createTaskMock.mockResolvedValueOnce({ id: 'task-persistent-1' });

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Persistent task' }));
    fireEvent.change(screen.getByLabelText('Task title'), {
      target: { value: 'Biweekly release' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'Biweekly release',
        metadata: { persistent: { enabled: true } },
      }));
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

    const daemonSelect = await screen.findByLabelText('Device');
    await waitFor(() => {
      expect(daemonSelect).toHaveValue('daemon-b');
    });
    expect(daemonSelect).toBeDisabled();
    expect(screen.getByText('Bound to daemon-b : /repo/bound')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Task title'), {
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

      const daemonSelect = await screen.findByLabelText('Device');
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

      fireEvent.change(screen.getByLabelText('Task title'), {
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

    describe('remote worktree (RFC 0038)', () => {
      const remoteCapable = ['pty_task', 'remote_exec', 'remote_file'];

      const openAdvanced = async () => {
        fireEvent.click(await screen.findByText('Advanced options'));
      };

      it('offers the other daemon of the group only when it can host a remote worktree', async () => {
        projectsState = { projects: mergedProjects };
        agentsState.agents = [
          { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude'], capabilities: remoteCapable },
          { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: ['pty_task'] },
        ];
        const view = render(<CreateTaskDialog open onClose={() => {}} />);
        await screen.findByLabelText('Device');
        await openAdvanced();
        // daemon-b lacks remote_exec / remote_file, so nothing to offer.
        expect(screen.queryByLabelText('Workspace on another daemon')).toBeNull();
        view.unmount();

        agentsState.agents[1] = { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: remoteCapable };
        render(<CreateTaskDialog open onClose={() => {}} />);
        await screen.findByLabelText('Device');
        await openAdvanced();
        const remoteSelect = await screen.findByLabelText('Workspace on another daemon');
        const labels = within(remoteSelect).getAllByRole('option').map((o) => o.textContent);
        // The AI's own daemon (daemon-a) is never listed; the default keeps things local.
        expect(labels[0]).toMatch(/Same daemon/);
        expect(labels.slice(1)).toEqual([expect.stringContaining('daemon-b')]);
        expect(labels.join(' ')).not.toMatch(/daemon-a/);
      });

      it('submits launchConfig.remoteWorktree.host and drops the local worktree flag', async () => {
        projectsState = { projects: mergedProjects };
        agentsState.agents = [
          { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude'], capabilities: remoteCapable },
          { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: remoteCapable },
        ];
        createTaskMock.mockResolvedValueOnce({ id: 'task-remote' });
        render(<CreateTaskDialog open onClose={() => {}} />);
        await screen.findByLabelText('Device');
        await openAdvanced();
        // Local worktree first, then remote: the remote choice must win and
        // uncheck the local one (the API rejects both together).
        const worktreeCheckbox = await screen.findByLabelText('Create task in a separate worktree');
        fireEvent.click(worktreeCheckbox);
        expect(worktreeCheckbox).toBeChecked();
        fireEvent.change(screen.getByLabelText('Workspace on another daemon'), { target: { value: 'daemon-b' } });
        expect(worktreeCheckbox).not.toBeChecked();

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Build on daemon-b' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
        await waitFor(() => {
          expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
            projectId: 'p-a',
            agentHost: 'daemon-a',
            launchConfig: { remoteWorktree: { host: 'daemon-b' } },
          }));
        });
      });

      it('re-checking the local worktree clears the remote host, and agent groups disable it', async () => {
        projectsState = { projects: mergedProjects };
        agentsState.agents = [
          { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude'], capabilities: remoteCapable },
          { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: remoteCapable },
        ];
        createTaskMock.mockResolvedValueOnce({ id: 'task-local' });
        render(<CreateTaskDialog open onClose={() => {}} />);
        await screen.findByLabelText('Device');
        await openAdvanced();
        const remoteSelect = await screen.findByLabelText('Workspace on another daemon');
        fireEvent.change(remoteSelect, { target: { value: 'daemon-b' } });
        expect((remoteSelect as HTMLSelectElement).value).toBe('daemon-b');
        fireEvent.click(screen.getByLabelText('Create task in a separate worktree'));
        expect((remoteSelect as HTMLSelectElement).value).toBe('');

        // Naming a worker agent makes it a group → remote worktree unavailable.
        const workerSelect = await screen.findByLabelText(/Agents/);
        fireEvent.change(workerSelect, { target: { value: 'feature-dev' } });
        expect(screen.getByLabelText('Workspace on another daemon')).toBeDisabled();
        expect(screen.getByText('Not available together with an agent group.')).toBeInTheDocument();

        fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Local worktree' } });
        fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
        await waitFor(() => {
          expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({
            launchConfig: { worktree: true },
          }));
        });
      });
    });
  });

  describe('global AI backends (RFC 0041)', () => {
    // The project's code lives on daemon-b; daemon-a has the AI account.
    const boundProject = {
      id: 'project-b',
      name: 'Hardware',
      daemonHost: 'daemon-b',
      workspacePath: '/repo/hw',
      repoRoot: '/repo/hw',
    };

    beforeEach(() => {
      projectsState = { projects: [boundProject] };
      agentsState.agents = [
        { id: 'daemon-1', host: 'daemon-a', supportedBackends: ['claude', 'codex'], capabilities: ['global_backend_v1'] },
        { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: ['remote_exec', 'remote_file'] },
      ];
    });

    it('greys out an AI daemon whose conductor is too old to be a global backend', () => {
      globalBackendsState.backends = [{ host: 'daemon-a', backend: 'claude' }];
      agentsState.agents = [{ ...agentsState.agents[0], capabilities: [] }, agentsState.agents[1]];
      render(<CreateTaskDialog open onClose={() => {}} />);
      const group = within(screen.getByLabelText('AI backend')).getByRole('group', { name: 'Global' });
      const option = within(group).getByRole('option') as HTMLOptionElement;
      expect(option.disabled).toBe(true);
      expect(option.textContent).toBe('claude @ daemon-a — upgrade conductor on daemon-a to use it as a global backend');
    });

    it('shows no Global group when none are configured', async () => {
      render(<CreateTaskDialog open onClose={() => {}} />);
      const backendSelect = await screen.findByLabelText('AI backend');
      expect(within(backendSelect).queryByRole('group', { name: 'Global' })).toBeNull();
      expect(within(backendSelect).getAllByRole('option').map((option) => option.textContent)).toEqual(['gpt']);
    });

    it('lists global backends of other daemons and greys out the ones that cannot run now', async () => {
      globalBackendsState.backends = [
        { host: 'daemon-a', backend: 'claude' },
        { host: 'daemon-a', backend: 'kimi' },
        { host: 'daemon-c', backend: 'claude' },
        { host: 'daemon-b', backend: 'gpt' },
      ];
      render(<CreateTaskDialog open onClose={() => {}} />);
      const group = within(await screen.findByLabelText('AI backend')).getByRole('group', { name: 'Global' });
      const options = within(group).getAllByRole('option') as HTMLOptionElement[];
      // The project's own daemon is not repeated under Global.
      expect(options.map((option) => option.textContent)).toEqual([
        'claude @ daemon-a',
        'kimi @ daemon-a — kimi is not available on daemon-a',
        'claude @ daemon-c — daemon-c is offline',
      ]);
      expect(options.map((option) => option.disabled)).toEqual([false, true, true]);
      expect(options[1].title).toBe('kimi is not available on daemon-a');
      expect(options[2].title).toBe('daemon-c is offline');
    });

    it('submits globalBackend with the worktree choice kept independent', async () => {
      globalBackendsState.backends = [{ host: 'daemon-a', backend: 'claude' }];
      createTaskMock.mockResolvedValue({ id: 'task-global' });
      render(<CreateTaskDialog open onClose={() => {}} />);
      fireEvent.change(await screen.findByLabelText('AI backend'), {
        target: { value: `global:daemon-a\u0000claude` },
      });
      expect(screen.getByText('AI runs on daemon-a and works on daemon-b through conductor remote.')).toBeInTheDocument();
      // Agent groups are not offered with a global backend.
      expect(screen.queryByLabelText(/Agents/)).toBeNull();

      fireEvent.click(screen.getByRole('checkbox', { name: 'Create task in a separate worktree' }));
      fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Remote fix' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
      await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
      const input = createTaskMock.mock.calls[0][0];
      expect(input).toMatchObject({
        projectId: 'project-b',
        globalBackend: { host: 'daemon-a', backend: 'claude' },
        backendType: 'claude',
        launchConfig: { worktree: true },
      });
      expect(input.agentHost).toBeUndefined();
      expect(input.agents).toBeUndefined();
    });

    it('greys out every global backend when the project daemon cannot be driven remotely', async () => {
      globalBackendsState.backends = [{ host: 'daemon-a', backend: 'claude' }];
      agentsState.agents = [
        agentsState.agents[0],
        { id: 'daemon-2', host: 'daemon-b', supportedBackends: ['gpt'], capabilities: [] },
      ];
      render(<CreateTaskDialog open onClose={() => {}} />);
      const group = within(await screen.findByLabelText('AI backend')).getByRole('group', { name: 'Global' });
      const option = within(group).getByRole('option') as HTMLOptionElement;
      expect(option.disabled).toBe(true);
      expect(option.title).toMatch(/daemon-b does not support conductor remote/);
    });

    it('drops a remembered global backend once the user picks an agent group instead', async () => {
      globalBackendsState.backends = [{ host: 'daemon-a', backend: 'claude' }];
      createTaskMock.mockResolvedValue({ id: 'task-group' });
      const view = render(<CreateTaskDialog open onClose={() => {}} />);
      fireEvent.change(await screen.findByLabelText('AI backend'), {
        target: { value: `global:daemon-a\u0000claude` },
      });
      // daemon-a disconnects: the choice becomes unavailable and the local form returns.
      const online = agentsState.agents;
      agentsState.agents = [online[1]];
      view.rerender(<CreateTaskDialog open onClose={() => {}} />);
      fireEvent.change(await screen.findByLabelText(/Agents/), { target: { value: 'feature-dev' } });
      // It reconnects: the agent group must survive.
      agentsState.agents = online;
      view.rerender(<CreateTaskDialog open onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Group' } });
      fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));
      await waitFor(() => expect(createTaskMock).toHaveBeenCalledTimes(1));
      const input = createTaskMock.mock.calls[0][0];
      expect(input.globalBackend).toBeUndefined();
      expect(input.agents).toEqual([{ name: 'feature-dev' }]);
    });

    it('keeps the no-backends warning when every global backend is unavailable', () => {
      globalBackendsState.backends = [{ host: 'daemon-c', backend: 'claude' }];
      agentsState.agents = [
        agentsState.agents[0],
        { id: 'daemon-2', host: 'daemon-b', supportedBackends: [], capabilities: ['remote_exec', 'remote_file'] },
      ];
      render(<CreateTaskDialog open onClose={() => {}} />);
      expect(screen.queryByLabelText('AI backend')).toBeNull();
      expect(screen.getByText(/does not advertise any AI backends yet/)).toBeInTheDocument();
    });
  });
});
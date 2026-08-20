import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RestartTaskControls } from './RestartTaskControls';

const pushMock = vi.fn();
const replaceMock = vi.fn();
const restartTaskMock = vi.fn();
const pushToastMock = vi.fn();
const FIXED_DATE = new Date('2024-01-15T10:00:00Z');

let agentsState = {
  agents: [] as Array<{ host: string; supportedBackends: string[]; runtimeBackendMap?: Record<string, string> }>,
};
let projectsState = {
  projects: [] as Array<{ id: string; daemonHost?: string | null }>,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
  usePathname: () => '/app/tasks',
  useSearchParams: () => new URLSearchParams('projectId=proj-1&taskId=task-1'),
}));

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

vi.mock('../store', () => ({
  useTasksStore: (selector: (state: { restartTask: typeof restartTaskMock }) => unknown) =>
    selector({ restartTask: restartTaskMock }),
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

describe('RestartTaskControls', () => {
  beforeEach(() => {
    agentsState = {
      agents: [
        {
          host: 'daemon-1',
          supportedBackends: ['codex', 'claude', 'opencode'],
        },
      ],
    };
    projectsState = {
      projects: [],
    };
    pushMock.mockReset();
    replaceMock.mockReset();
    restartTaskMock.mockReset();
    pushToastMock.mockReset();
  });

  it('opens as a dialog for creating a new task on the current backend', () => {
    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'New task from this' })).toBeInTheDocument();
    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
    expect(screen.queryByText('Continue as')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
    // Any backend the daemon supports is a valid cross-handoff target, including
    // opencode (previously filtered out when the bridge was a hardcoded set).
    expect(screen.getByRole('option', { name: 'opencode' })).toBeInTheDocument();
  });

  it('keeps running tasks on the new-task flow and keeps same-backend available', () => {
    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Running Task',
          taskType: 'ai_task',
          status: 'running',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
    expect(screen.queryByLabelText('In place')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
  });

  it('navigates to the successor task after creating a new task', async () => {
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-2',
      },
    });
    const onClose = vi.fn();

    render(
      <RestartTaskControls
        open
        onClose={onClose}
        task={{
          id: 'task-1',
          title: 'Running Task',
          taskType: 'ai_task',
          status: 'running',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
      });
      expect(replaceMock).toHaveBeenCalledWith('/app/tasks?projectId=proj-1&taskId=task-2', { scroll: false });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('prefers onCreatedTask over URL navigation to open the successor', async () => {
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-2',
      },
    });
    const onClose = vi.fn();
    const onCreatedTask = vi.fn();

    render(
      <RestartTaskControls
        open
        onClose={onClose}
        onCreatedTask={onCreatedTask}
        task={{
          id: 'task-1',
          title: 'Running Task',
          taskType: 'ai_task',
          status: 'running',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
      });
      // The successor id is handed to the caller so it can update local
      // selection state, not just the URL.
      expect(onCreatedTask).toHaveBeenCalledWith('task-2');
      expect(onClose).toHaveBeenCalled();
    });
    // When a caller opts into onCreatedTask, we must NOT also mutate the URL
    // ourselves (the reconciler would otherwise fight the local selection).
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it('creates a new task for stopped same-backend tasks', async () => {
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-2',
      },
    });
    const onClose = vi.fn();

    render(
      <RestartTaskControls
        open
        onClose={onClose}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'completed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
      });
      expect(replaceMock).toHaveBeenCalledWith('/app/tasks?projectId=proj-1&taskId=task-2', { scroll: false });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('treats unknown tasks as eligible for new-task restart', () => {
    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-unknown-1',
          title: 'Unknown Task',
          taskType: 'ai_task',
          status: 'unknown',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-unknown-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();
  });

  it('keeps the popup on new-task mode when backend changes', async () => {
    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Backend'), {
      target: { value: 'claude' },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('Backend')).toHaveValue('claude');
    });
    expect(screen.getByRole('button', { name: 'New task' })).toBeInTheDocument();
  });

  it('allows a stopped conductor-fire task to create a new task on an online daemon', () => {
    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-fire-1',
          title: 'Stopped Fire Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'conductor-fire-mac-1',
          executionHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-fire-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();
  });

  it('uses metadata daemonName when a conductor-fire task has no persisted execution daemon host', () => {
    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-fire-1b',
          title: 'Stopped Fire Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'conductor-fire-mac-1',
          executionHost: null,
          backendType: 'codex',
          sessionId: 'sess-fire-1b',
          metadata: { daemonName: 'daemon-1' },
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();
  });

  it('uses the bound project daemon when a conductor-fire task has no daemon metadata yet', () => {
    projectsState = {
      projects: [
        {
          id: 'project-1',
          daemonHost: 'daemon-1',
        },
      ],
    };

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-fire-1c',
          projectId: 'project-1',
          title: 'Stopped Fire Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'conductor-fire-mac-1',
          executionHost: 'conductor-fire-mac-1',
          backendType: 'codex',
          sessionId: 'sess-fire-1c',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
    expect(screen.getByRole('option', { name: 'claude' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();
  });

  it('lets a conductor-fire task without an original daemon binding branch onto an explicitly chosen daemon', async () => {
    // Previously this case was a hard block. With the daemon selector the
    // user can pick any online daemon — but only explicitly: nothing is
    // preselected behind their back, and the choice is sent as an agent_host
    // override so the server skips auto-resolution.
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-fire-2',
      task: { id: 'task-fire-2-successor' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-fire-2',
          title: 'Stopped Fire Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'conductor-fire-mac-1',
          executionHost: 'conductor-fire-mac-1',
          backendType: 'codex',
          sessionId: 'sess-fire-2',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    // No auto-resolvable daemon: require an explicit choice.
    expect(screen.getByLabelText('Daemon')).toHaveValue('');
    const submitButton = screen.getByRole('button', { name: 'New task' });
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveAttribute('title', 'Select a daemon to run the new task');

    fireEvent.change(screen.getByLabelText('Daemon'), {
      target: { value: 'daemon-1' },
    });
    // The chosen daemon is a different machine: warn that the source working
    // directory does not carry over.
    expect(screen.getByText(/different machine than the source task/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-fire-2', {
        backendType: 'codex',
        strategy: 'new_task',
        agentHost: 'daemon-1',
      });
    });
  });

  it('disables restart when no daemon is online', () => {
    agentsState = { agents: [] };

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-fire-2',
          title: 'Stopped Fire Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'conductor-fire-mac-1',
          executionHost: 'conductor-fire-mac-1',
          backendType: 'codex',
          sessionId: 'sess-fire-2',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New task' })).toHaveAttribute('title', 'No daemon online');
  });

  it('offers every daemon-supported backend as a handoff target, including arbitrary external providers', () => {
    // Backend-agnostic handoff: the share-link mechanism makes any pair valid,
    // so a task running on an external provider can hand off to a built-in
    // (or vice versa) as long as the daemon advertises both.
    agentsState = {
      agents: [
        {
          host: 'daemon-1',
          supportedBackends: ['codex', 'test-external'],
        },
      ],
    };

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-external-1',
          title: 'External Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'test-external',
          sessionId: 'sess-external-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Backend')).toHaveValue('test-external');
    expect(screen.getByRole('option', { name: 'test-external' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();
  });

  it('offers bridged built-in aliases only when the daemon provides a runtime backend map', () => {
    agentsState = {
      agents: [
        {
          host: 'daemon-1',
          supportedBackends: ['codex-gamma', 'claude'],
          runtimeBackendMap: {
            'codex-gamma': 'codex',
            claude: 'claude',
          },
        },
      ],
    };

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-codex-gamma-1',
          title: 'Codex Alias Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex-gamma',
          sessionId: 'sess-codex-gamma-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByRole('option', { name: 'codex-gamma' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'claude' })).toBeInTheDocument();
  });

  it('offers built-in cross-bridges even when the source backend is a distinct external provider', () => {
    // Under the share-link handoff, `codex-enterprise` → `claude` is a valid
    // pair regardless of whether `codex-enterprise` aliases a built-in or
    // sits on its own; the target daemon advertising both is the only gate.
    agentsState = {
      agents: [
        {
          host: 'daemon-1',
          supportedBackends: ['codex-enterprise', 'claude'],
          runtimeBackendMap: {
            'codex-enterprise': 'codex-enterprise',
            claude: 'claude',
          },
        },
      ],
    };

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-codex-enterprise-1',
          title: 'External Prefix Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex-enterprise',
          sessionId: 'sess-codex-enterprise-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByRole('option', { name: 'codex-enterprise' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'claude' })).toBeInTheDocument();
  });

  it('lists online daemons and defaults to the source daemon marked as current', () => {
    agentsState = {
      agents: [
        { host: 'daemon-1', supportedBackends: ['codex', 'claude'] },
        { host: 'daemon-2', supportedBackends: ['claude'] },
        // Fire connections are not spawn targets and must not be offered.
        { host: 'conductor-fire-mac-1', supportedBackends: ['codex'] },
      ],
    };

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-1');
    expect(screen.getByRole('option', { name: 'daemon-1 (current)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'daemon-2' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /conductor-fire/ })).not.toBeInTheDocument();
  });

  it('sends the selected daemon as agent_host override and recomputes backends from it', async () => {
    agentsState = {
      agents: [
        { host: 'daemon-1', supportedBackends: ['codex', 'claude'] },
        { host: 'daemon-2', supportedBackends: ['claude'] },
      ],
    };
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: { id: 'task-2' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Daemon'), {
      target: { value: 'daemon-2' },
    });

    // daemon-2 does not support codex, so the backend falls back to the
    // first backend that daemon actually advertises.
    await waitFor(() => {
      expect(screen.getByLabelText('Backend')).toHaveValue('claude');
    });

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'claude',
        strategy: 'new_task',
        agentHost: 'daemon-2',
      });
    });
  });

  it('omits the agent_host override when the default source daemon stays selected', async () => {
    agentsState = {
      agents: [
        { host: 'daemon-1', supportedBackends: ['codex', 'claude'] },
        { host: 'daemon-2', supportedBackends: ['claude'] },
      ],
    };
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: { id: 'task-2' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      // No agentHost key: the server keeps its own auto-resolution (including
      // project daemon binding checks) for the default path.
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
      });
    });
  });

  it('requires an explicit daemon choice when the source daemon is offline', async () => {
    // The source daemon being offline must NOT silently move the branch to
    // another machine: nothing is preselected and the submit stays disabled
    // until the user actively picks a daemon.
    agentsState = {
      agents: [{ host: 'daemon-2', supportedBackends: ['codex', 'claude'] }],
    };
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: { id: 'task-2' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('');
    const submitButton = screen.getByRole('button', { name: 'New task' });
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveAttribute(
      'title',
      'Source daemon daemon-1 is offline — select a daemon to run the new task',
    );

    fireEvent.change(screen.getByLabelText('Daemon'), {
      target: { value: 'daemon-2' },
    });
    expect(screen.getByText(/different machine than the source task/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
        agentHost: 'daemon-2',
      });
    });
  });

  it('defaults a fire task to the first ONLINE daemon candidate, matching server auto-resolution', async () => {
    // metadata daemon A is offline; execution daemon B is online. The server
    // auto-resolves to the first ONLINE candidate (B), so the UI must default
    // to B too — not to an arbitrary online daemon like C. Because B is NOT
    // the machine the source workspace lives on (A), the submit must carry an
    // explicit agent_host so the server's cross-daemon guard drops the
    // source-machine paths instead of shipping them to B.
    agentsState = {
      agents: [
        { host: 'daemon-c', supportedBackends: ['codex'] },
        { host: 'daemon-b', supportedBackends: ['codex'] },
      ],
    };
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-fire-4',
      task: { id: 'task-fire-4-successor' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-fire-4',
          title: 'Stopped Fire Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'conductor-fire-mac-1',
          executionHost: 'daemon-b',
          metadata: { daemonName: 'daemon-a' },
          backendType: 'codex',
          sessionId: 'sess-fire-4',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-b');
    expect(screen.getByText(/different machine than the source task/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-fire-4', {
        backendType: 'codex',
        strategy: 'new_task',
        agentHost: 'daemon-b',
      });
    });
  });

  it('defaults to the project-bound daemon and sends it explicitly when it differs from the source daemon', async () => {
    // The server's auto-resolution forces the project daemon binding, so the
    // UI must show that binding as the default target. Since it is a
    // different machine from where the source task ran, the submit carries an
    // explicit agent_host so dispatch matches the display and the
    // cross-daemon path-drop guard applies.
    agentsState = {
      agents: [
        { host: 'daemon-1', supportedBackends: ['codex'] },
        { host: 'daemon-p', supportedBackends: ['codex'] },
      ],
    };
    projectsState = {
      projects: [{ id: 'project-1', daemonHost: 'daemon-p' }],
    };
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: { id: 'task-2' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          projectId: 'project-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-p');
    expect(screen.getByText(/different machine than the source task/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
        agentHost: 'daemon-p',
      });
    });
  });

  it('does not warn about machines when the explicit choice is the source daemon itself', async () => {
    // Project daemon P is bound but offline, so nothing auto-resolves. The
    // user picks the source daemon itself: the override is still sent (so
    // dispatch matches the display), but this is NOT a cross-machine branch,
    // so no warning is shown and the server keeps the inherited workspace.
    agentsState = {
      agents: [{ host: 'daemon-1', supportedBackends: ['codex'] }],
    };
    projectsState = {
      projects: [{ id: 'project-1', daemonHost: 'daemon-p' }],
    };
    restartTaskMock.mockResolvedValue({
      mode: 'successor_new_task',
      sourceTaskId: 'task-1',
      task: { id: 'task-2' },
    });

    render(
      <RestartTaskControls
        open
        onClose={() => {}}
        task={{
          id: 'task-1',
          projectId: 'project-1',
          title: 'Stopped Task',
          taskType: 'ai_task',
          status: 'killed',
          agentHost: 'daemon-1',
          backendType: 'codex',
          sessionId: 'sess-1',
          createdAt: FIXED_DATE.toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Daemon')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'New task' })).toHaveAttribute(
      'title',
      'Project daemon daemon-p is offline — select a daemon to run the new task',
    );

    fireEvent.change(screen.getByLabelText('Daemon'), {
      target: { value: 'daemon-1' },
    });

    expect(screen.queryByText(/different machine than the source task/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
        agentHost: 'daemon-1',
      });
    });
  });

  it('resets a tentative daemon choice when the dialog is reopened', async () => {
    agentsState = {
      agents: [
        { host: 'daemon-1', supportedBackends: ['codex'] },
        { host: 'daemon-2', supportedBackends: ['codex'] },
      ],
    };
    const task = {
      id: 'task-1',
      title: 'Stopped Task',
      taskType: 'ai_task',
      status: 'killed',
      agentHost: 'daemon-1',
      backendType: 'codex',
      sessionId: 'sess-1',
      createdAt: FIXED_DATE.toISOString(),
    } as const;

    const { rerender } = render(
      <RestartTaskControls open onClose={() => {}} task={task} />,
    );

    fireEvent.change(screen.getByLabelText('Daemon'), {
      target: { value: 'daemon-2' },
    });
    expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-2');

    rerender(<RestartTaskControls open={false} onClose={() => {}} task={task} />);
    rerender(<RestartTaskControls open onClose={() => {}} task={task} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Daemon')).toHaveValue('daemon-1');
    });
  });
});

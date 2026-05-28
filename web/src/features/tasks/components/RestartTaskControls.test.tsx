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

  it('disables restart when a conductor-fire task is missing its original daemon binding', () => {
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

    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled();
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
});

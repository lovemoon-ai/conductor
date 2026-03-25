import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RestartTaskControls } from './RestartTaskControls';

const pushMock = vi.fn();
const replaceMock = vi.fn();
const restartTaskMock = vi.fn();
const clearRuntimeMock = vi.fn();
const pushToastMock = vi.fn();

let agentsState = {
  agents: [] as Array<{ host: string; supportedBackends: string[] }>,
};

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
  usePathname: () => '/app/tasks',
  useSearchParams: () => new URLSearchParams('projectId=proj-1&taskId=task-1'),
}));

vi.mock('@/lib/conductor/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: (selector: (state: { restartTask: typeof restartTaskMock }) => unknown) =>
    selector({ restartTask: restartTaskMock }),
}));

vi.mock('@/lib/conductor/stores/runtime', () => ({
  useRuntimeStore: (selector: (state: { clearTask: typeof clearRuntimeMock }) => unknown) =>
    selector({ clearTask: clearRuntimeMock }),
}));

vi.mock('../common/FeedbackProvider', () => ({
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
    pushMock.mockReset();
    replaceMock.mockReset();
    restartTaskMock.mockReset();
    clearRuntimeMock.mockReset();
    pushToastMock.mockReset();
  });

  it('opens as a dialog and defaults stopped tasks to in-place restart on the current backend', () => {
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Restart task' })).toBeInTheDocument();
    expect(screen.getByLabelText('Restart backend')).toHaveValue('codex');
    expect(screen.getByLabelText('In place')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Restart in place' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'opencode' })).not.toBeInTheDocument();
  });

  it('forces running tasks into create-new-task strategy and keeps same-backend available', () => {
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Restart backend')).toHaveValue('codex');
    expect(screen.getByLabelText('In place')).toBeDisabled();
    expect(screen.getByLabelText('New task')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Create new task' })).toBeInTheDocument();
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Create new task' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'new_task',
      });
      expect(replaceMock).toHaveBeenCalledWith('/app/tasks?projectId=proj-1&taskId=task-2', { scroll: false });
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('runs stopped same-backend in-place restart and clears runtime state', async () => {
    restartTaskMock.mockResolvedValue({
      mode: 'inplace_restart',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-1',
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Restart in place' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', {
        backendType: 'codex',
        strategy: 'inplace',
      });
      expect(clearRuntimeMock).toHaveBeenCalledWith('task-1');
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('switches stopped tasks to create-new-task mode when backend changes', async () => {
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Restart backend'), {
      target: { value: 'claude' },
    });

    await waitFor(() => {
      expect(screen.getByLabelText('New task')).toBeChecked();
    });
    expect(screen.getByRole('button', { name: 'Create new task' })).toBeInTheDocument();
  });

  it('allows a stopped conductor-fire task to restart on an online daemon', () => {
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    expect(screen.getByLabelText('Restart backend')).toHaveValue('codex');
    expect(screen.getByLabelText('In place')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Restart in place' })).toBeEnabled();
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
          createdAt: new Date().toISOString(),
        }}
      />,
    );

    expect(screen.getByRole('button', { name: 'Restart in place' })).toBeDisabled();
  });
});

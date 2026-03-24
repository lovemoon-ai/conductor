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
          supportedBackends: ['codex', 'claude'],
        },
      ],
    };
    pushMock.mockReset();
    replaceMock.mockReset();
    restartTaskMock.mockReset();
    clearRuntimeMock.mockReset();
    pushToastMock.mockReset();
  });

  it('shows restart UI for stopped ai tasks and limits backend options to the source daemon', () => {
    render(
      <RestartTaskControls
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

    expect(screen.getByRole('button', { name: 'Restart' })).toBeInTheDocument();
    const select = screen.getByLabelText('Restart backend');
    expect(select).toHaveValue('codex');
    expect(screen.getByRole('option', { name: 'codex' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'claude' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'kimi' })).not.toBeInTheDocument();
  });

  it('navigates to the successor task after backend switch', async () => {
    restartTaskMock.mockResolvedValue({
      mode: 'backend_switch_new_task',
      sourceTaskId: 'task-1',
      task: {
        id: 'task-2',
      },
    });

    render(
      <RestartTaskControls
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

    fireEvent.change(screen.getByLabelText('Restart backend'), {
      target: { value: 'claude' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch Backend' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', 'claude');
      expect(replaceMock).toHaveBeenCalledWith('/app/tasks?projectId=proj-1&taskId=task-2', { scroll: false });
    });
  });

  it('stops click propagation and switches to a supported backend when the current backend is no longer available', async () => {
    agentsState = {
      agents: [
        {
          host: 'daemon-1',
          supportedBackends: ['claude', 'kimi'],
        },
      ],
    };

    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <RestartTaskControls
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
        />
      </div>,
    );

    await waitFor(() => {
      expect(screen.getByLabelText('Restart backend')).toHaveValue('claude');
    });
    expect(
      screen.getByText('Current backend is no longer supported on the source daemon. Switch to claude to continue.'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch Backend' }));

    await waitFor(() => {
      expect(restartTaskMock).toHaveBeenCalledWith('task-1', 'claude');
    });
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('stops keyboard propagation from restart controls', () => {
    const parentKeyDown = vi.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <RestartTaskControls
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
        />
      </div>,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Restart' }), { key: 'Enter' });

    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  it('preserves a user-selected backend when the agent list refreshes for the same task', async () => {
    const task = {
      id: 'task-1',
      title: 'Stopped Task',
      taskType: 'ai_task' as const,
      status: 'killed' as const,
      agentHost: 'daemon-1',
      backendType: 'codex',
      sessionId: 'sess-1',
      createdAt: new Date().toISOString(),
    };

    const { rerender } = render(<RestartTaskControls task={task} />);

    fireEvent.change(screen.getByLabelText('Restart backend'), {
      target: { value: 'claude' },
    });
    expect(screen.getByLabelText('Restart backend')).toHaveValue('claude');

    agentsState = {
      agents: [
        {
          host: 'daemon-1',
          supportedBackends: ['codex', 'claude'],
        },
      ],
    };

    rerender(<RestartTaskControls task={task} />);

    await waitFor(() => {
      expect(screen.getByLabelText('Restart backend')).toHaveValue('claude');
    });
    expect(screen.getByRole('button', { name: 'Switch Backend' })).toBeInTheDocument();
  });
});

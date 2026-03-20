import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';
import { ApiRequestError } from '@/lib/conductor/api/client';

const pushMock = vi.fn();
const createTaskMock = vi.fn();

const projectsState = {
  projects: [
    { id: 'project-1', name: 'Project One' },
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

vi.mock('../common/Dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

vi.mock('@/lib/conductor/stores/tasks', () => ({
  useTasksStore: (selector: (state: { createTask: typeof createTaskMock }) => unknown) =>
    selector({ createTask: createTaskMock }),
}));

vi.mock('@/lib/conductor/stores/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));

vi.mock('@/lib/conductor/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

describe('CreateTaskDialog', () => {
  beforeEach(() => {
    createTaskMock.mockReset();
    pushMock.mockReset();
    vi.restoreAllMocks();
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
    expect(screen.queryByText('Conversation-first task routed through the AI runner. Pick a daemon, then choose one of its available backends.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show help for AI Task' }));
    expect(screen.getByText('Conversation-first task routed through the AI runner. Pick a daemon, then choose one of its available backends.')).toBeInTheDocument();
  });

  it('shows inline error when create task hits free plan limit', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    createTaskMock.mockRejectedValueOnce(
      new ApiRequestError(403, {
        error: 'Task limit reached',
        message: 'Free plan allows only one active app task',
        limit_type: 'app_active_task',
      }),
    );

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Need a task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(screen.getByText('已超出当前套餐限额：Free 最多只能有 1 个活跃 app task。')).toBeInTheDocument();
    });
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('shows inline error when create task hits plus plan limit', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    createTaskMock.mockRejectedValueOnce(
      new ApiRequestError(403, {
        error: 'Task limit reached',
        message: 'Plus plan allows only ten active manual fire tasks',
        limit_type: 'manual_fire_active_task',
      }),
    );

    render(<CreateTaskDialog open onClose={() => {}} />);

    fireEvent.change(screen.getByPlaceholderText('What do you want to accomplish?'), {
      target: { value: 'Need a plus task' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create AI Task' }));

    await waitFor(() => {
      expect(screen.getByText('已超出当前套餐限额：Plus 最多只能有 10 个活跃 fire task。')).toBeInTheDocument();
    });
    expect(alertSpy).not.toHaveBeenCalled();
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
  });
});

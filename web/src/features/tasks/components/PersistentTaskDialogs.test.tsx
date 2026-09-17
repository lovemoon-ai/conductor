import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Task } from '@/shared/types';
import { NewRoundDialog, PersistentTaskSettingsDialog } from './PersistentTaskDialogs';

const fetchTaskMock = vi.fn();
const updateTaskPersistentMock = vi.fn();

const agentsState = {
  agents: [
    { host: 'mac-mini', supportedBackends: ['claude', 'codex'] },
    { host: 'ubuntu', supportedBackends: ['codex'] },
  ],
};
const projectsState = { projects: [{ id: 'project-1', daemonHost: 'mac-mini' }] };

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));
vi.mock('@/features/projects', () => ({
  useProjectsStore: (selector: (state: typeof projectsState) => unknown) => selector(projectsState),
}));
vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));
vi.mock('../store', () => ({
  useTasksStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ fetchTask: fetchTaskMock, updateTaskPersistent: updateTaskPersistentMock }),
}));

const buildTask = (persistent: Record<string, unknown>): Task => ({
  id: 'task-1',
  title: 'Release',
  status: 'running',
  metadata: { persistent: { enabled: true, ...persistent } },
  createdAt: '2026-09-17T00:00:00.000Z',
});

describe('PersistentTaskSettingsDialog', () => {
  beforeEach(() => {
    fetchTaskMock.mockReset();
    updateTaskPersistentMock.mockReset().mockResolvedValue(buildTask({}));
  });

  it('keeps typed instructions when the refreshed task arrives and saves only edited fields', async () => {
    let resolveFetch: (task: Task) => void = () => {};
    fetchTaskMock.mockReturnValue(new Promise<Task>((resolve) => { resolveFetch = resolve; }));
    const onClose = vi.fn();

    render(<PersistentTaskSettingsDialog task={buildTask({ summary: 'stale' })} open onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Standing instructions'), {
      target: { value: 'Keep replies short.' },
    });
    await act(async () => {
      resolveFetch(buildTask({ summary: 'Released 0.14.0' }));
    });

    expect(screen.getByLabelText('Standing instructions')).toHaveValue('Keep replies short.');
    expect(screen.getByLabelText('Summary of previous rounds')).toHaveValue('Released 0.14.0');

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateTaskPersistentMock).toHaveBeenCalledWith('task-1', { instructions: 'Keep replies short.' });
  });
});

describe('NewRoundDialog', () => {
  const task = (overrides: Partial<Task> = {}): Task => ({
    ...buildTask({ round: 2 }),
    projectId: 'project-1',
    agentHost: 'ubuntu',
    backendType: 'codex',
    ...overrides,
  });

  it('defaults to the previous round and only sends what the user changed', async () => {
    const onStartRound = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<NewRoundDialog task={task()} open onClose={onClose} onStartRound={onStartRound} />);

    expect(screen.getByLabelText('Daemon')).toHaveValue('ubuntu');
    expect(screen.getByLabelText('Backend')).toHaveValue('codex');
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'Ship 0.15.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start round' }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onStartRound).toHaveBeenCalledWith({ content: 'Ship 0.15.0', backendType: 'codex', worktree: 'inherit' });
  });

  it('sends the daemon and workspace the user picked', async () => {
    const onStartRound = vi.fn().mockResolvedValue(undefined);
    render(<NewRoundDialog task={task()} open onClose={vi.fn()} onStartRound={onStartRound} />);

    fireEvent.change(screen.getByLabelText('Daemon'), { target: { value: 'mac-mini' } });
    fireEvent.change(screen.getByLabelText('Backend'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'new' } });
    fireEvent.change(screen.getByLabelText('First message'), { target: { value: 'go' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start round' }));

    await waitFor(() =>
      expect(onStartRound).toHaveBeenCalledWith({
        content: 'go',
        backendType: 'claude',
        agentHost: 'mac-mini',
        worktree: 'new',
      }),
    );
  });
});

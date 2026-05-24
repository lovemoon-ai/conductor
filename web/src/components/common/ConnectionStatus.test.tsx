import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionStatus } from './ConnectionStatus';

const useParamsMock = vi.fn();
const useWebSocketStoreMock = vi.fn();
const useRuntimeStoreMock = vi.fn();
const useTasksStoreMock = vi.fn();
const useAgentsStoreMock = vi.fn();

vi.mock('next/navigation', () => ({
  useParams: () => useParamsMock(),
}));

vi.mock('@/features/realtime', () => ({
  useWebSocketStore: (selector: (state: { status: 'connected' | 'connecting' | 'disconnected' }) => unknown) =>
    useWebSocketStoreMock(selector),
  useRuntimeStore: (selector: (state: { byTask: Record<string, unknown> }) => unknown) =>
    useRuntimeStoreMock(selector),
}));

vi.mock('@/features/tasks', () => ({
  useTasksStore: (selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
    useTasksStoreMock(selector),
}));

vi.mock('@/features/agents', () => ({
  useAgentsStore: (selector: (state: { agents: Array<Record<string, unknown>> }) => unknown) =>
    useAgentsStoreMock(selector),
}));

describe('ConnectionStatus', () => {
  beforeEach(() => {
    useParamsMock.mockReset();
    useWebSocketStoreMock.mockReset();
    useRuntimeStoreMock.mockReset();
    useTasksStoreMock.mockReset();
    useAgentsStoreMock.mockReset();

    useParamsMock.mockReturnValue({ taskId: 'task-123' });
    useWebSocketStoreMock.mockImplementation((selector: (state: { status: 'connected' }) => unknown) =>
      selector({ status: 'connected' }),
    );
    useRuntimeStoreMock.mockImplementation((selector: (state: { byTask: Record<string, unknown> }) => unknown) =>
      selector({
        byTask: {
          'task-123': {
            taskId: 'task-123',
            daemon: 'daemon-a',
            pid: 2345,
            backend: 'codex',
            sessionId: 'session-xyz',
            tokenUsagePercent: 12,
            contextUsagePercent: 34,
          },
        },
      }),
    );
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [{ id: 'task-123', executionHost: 'daemon-a' }],
      }),
    );
    useAgentsStoreMock.mockImplementation((selector: (state: { agents: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        agents: [{ id: 'agent-1', host: 'daemon-a' }],
      }),
    );
  });

  it('shows task id and runtime detail fields in required order when details are enabled', () => {
    render(<ConnectionStatus detailsEnabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    expect(screen.getByText('task-123')).toBeInTheDocument();

    const details = screen.getByText('Runtime Details').parentElement;
    expect(details).not.toBeNull();

    const labels = Array.from(details!.querySelectorAll('span.text-muted')).map((item) => item.textContent);
    expect(labels).toEqual([
      'Connection',
      'Task ID',
      'Daemon',
      'PID',
      'Backend',
      'AI Mode',
      'Session ID',
      'Token Usage',
      'Context Usage',
    ]);
    // No goal => Turn label, no badge, no objective row
    expect(screen.getByText('Turn')).toBeInTheDocument();
    expect(screen.queryByTestId('goal-mode-badge')).toBeNull();
    expect(screen.queryByText('Goal Objective')).toBeNull();
  });

  it('shows the Goal badge and objective when task metadata.aiMode is goal', () => {
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [
          {
            id: 'task-123',
            executionHost: 'daemon-a',
            metadata: {
              aiMode: 'goal',
              goal: { source: 'issue', issueId: 'I-7', status: 'created' },
              initialContent: 'ship the release end-to-end',
            },
            launchConfig: {
              aiMode: 'goal',
              goal: {
                objective: 'ship the release end-to-end',
                source: 'issue',
                issueId: 'I-7',
              },
            },
          },
        ],
      }),
    );

    render(<ConnectionStatus detailsEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    const badge = screen.getByTestId('goal-mode-badge');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('Goal');
    expect(screen.getByText('Goal Objective')).toBeInTheDocument();
    expect(screen.getByText('ship the release end-to-end')).toBeInTheDocument();
    // source + status hint
    expect(screen.getByText(/via issue.*created/)).toBeInTheDocument();
  });

  it('falls back to launchConfig.goal.objective when metadata.initialContent is absent', () => {
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [
          {
            id: 'task-123',
            executionHost: 'daemon-a',
            metadata: { aiMode: 'goal', goal: { source: 'manual' } },
            launchConfig: { aiMode: 'goal', goal: { objective: 'manual cli goal', source: 'manual' } },
          },
        ],
      }),
    );

    render(<ConnectionStatus detailsEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    expect(screen.getByTestId('goal-mode-badge')).toBeInTheDocument();
    expect(screen.getByText('manual cli goal')).toBeInTheDocument();
  });

  it('does not show the Goal badge for normal turn-mode tasks', () => {
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [
          {
            id: 'task-123',
            executionHost: 'daemon-a',
            metadata: { aiMode: 'turn' },
          },
        ],
      }),
    );

    render(<ConnectionStatus detailsEnabled />);
    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    expect(screen.queryByTestId('goal-mode-badge')).toBeNull();
    expect(screen.getByText('Turn')).toBeInTheDocument();
  });

  it('uses a dark panel with white text for pty tasks', () => {
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [{ id: 'task-123', executionHost: 'daemon-a', taskType: 'pty_task' }],
      }),
    );

    render(<ConnectionStatus detailsEnabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    const details = screen.getByText('Runtime Details').parentElement;
    expect(details).not.toBeNull();
    expect(details!.className).toContain('bg-zinc-950/70');
    expect(details!.className).toContain('text-white');
    expect(details!.className).toContain('backdrop-blur-md');
  });

  it('uses the explicit task id override to resolve pty styling outside task routes', () => {
    useParamsMock.mockReturnValue({});
    useRuntimeStoreMock.mockImplementation((selector: (state: { byTask: Record<string, unknown> }) => unknown) =>
      selector({
        byTask: {
          'task-pty-9': {
            taskId: 'task-pty-9',
            daemon: 'daemon-a',
            pid: 998,
            backend: 'codex',
            sessionId: 'session-pty-9',
            tokenUsagePercent: 1,
            contextUsagePercent: 2,
          },
        },
      }),
    );
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [{ id: 'task-pty-9', executionHost: 'daemon-a', taskType: 'pty_task' }],
      }),
    );

    render(<ConnectionStatus detailsEnabled taskId="task-pty-9" />);

    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    const details = screen.getByText('Runtime Details').parentElement;
    expect(details).not.toBeNull();
    expect(details!.className).toContain('bg-zinc-950/70');
    expect(screen.getByText('task-pty-9')).toBeInTheDocument();
  });

  it('keeps the status indicator visible but does not open details when disabled', () => {
    render(<ConnectionStatus />);

    const button = screen.getByRole('button', { name: 'Open connection details' });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);

    expect(screen.queryByText('Runtime Details')).toBeNull();
  });

  it('falls back to persisted task backend and session when runtime fields are missing', () => {
    useRuntimeStoreMock.mockImplementation((selector: (state: { byTask: Record<string, unknown> }) => unknown) =>
      selector({
        byTask: {
          'task-123': {
            taskId: 'task-123',
            daemon: 'daemon-a',
            pid: 2345,
          },
        },
      }),
    );
    useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
      selector({
        tasks: [
          {
            id: 'task-123',
            executionHost: 'daemon-a',
            backendType: 'codex',
            sessionId: 'session-persisted-1',
          },
        ],
      }),
    );

    render(<ConnectionStatus detailsEnabled />);

    fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('session-persisted-1')).toBeInTheDocument();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConnectionStatus } from './ConnectionStatus';

const useParamsMock = vi.fn();
const useWebSocketStoreMock = vi.fn();
const useRuntimeStoreMock = vi.fn();
const useTasksStoreMock = vi.fn();

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

describe('ConnectionStatus', () => {
  beforeEach(() => {
    useParamsMock.mockReset();
    useWebSocketStoreMock.mockReset();
    useRuntimeStoreMock.mockReset();
    useTasksStoreMock.mockReset();

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
        tasks: [{ id: 'task-123', executionHost: 'daemon-a', activeScheduledMessageCount: 2 }],
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
      'Task ID',
      'PID',
      'Scheduled',
      'Session ID',
      'Token Usage',
      'Context Usage',
    ]);
    expect(screen.getByText('2 active')).toBeInTheDocument();
    expect(screen.queryByText('Connection')).toBeNull();
    expect(screen.queryByText('Daemon')).toBeNull();
    expect(screen.queryByText('Backend')).toBeNull();
    expect(screen.queryByText('AI Mode')).toBeNull();
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

  it('falls back to the persisted task session when runtime fields are missing', () => {
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

    expect(screen.getByText('session-persisted-1')).toBeInTheDocument();
    expect(screen.queryByText('Backend')).toBeNull();
  });
});

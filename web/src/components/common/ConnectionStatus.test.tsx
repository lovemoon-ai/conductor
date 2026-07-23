import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  describe('double-click to copy', () => {
    const writeText = vi.fn();
    let originalExecCommand: typeof document.execCommand;

    beforeEach(() => {
      originalExecCommand = document.execCommand;
      writeText.mockReset().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText },
      });
      Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    });

    afterEach(() => {
      vi.useRealTimers();
      document.execCommand = originalExecCommand;
    });

    it('copies the task id and shows a Copied bubble that disappears after 2s', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      fireEvent.doubleClick(screen.getByText('task-123'), { clientX: 120, clientY: 80 });

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('task-123'));
      const bubble = await screen.findByText('Copied');
      expect(bubble).toBeInTheDocument();
      expect(bubble.style.left).toBe('132px');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText('Copied')).toBeNull();
    });

    it('copies on a touch long-press and shows the bubble at the touch point', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      const taskIdValue = screen.getByText('task-123');
      fireEvent.pointerDown(taskIdValue, { pointerType: 'touch', clientX: 60, clientY: 200 });

      expect(writeText).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(500);
      });

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('task-123'));
      expect(await screen.findByText('Copied')).toBeInTheDocument();
    });

    it('cancels the long-press copy when the finger moves (scrolling)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      const taskIdValue = screen.getByText('task-123');
      fireEvent.pointerDown(taskIdValue, { pointerType: 'touch', clientX: 60, clientY: 200 });
      fireEvent.pointerMove(taskIdValue, { pointerType: 'touch', clientX: 60, clientY: 240 });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByText('Copied')).toBeNull();
    });

    it('does not start a long-press for mouse pointers', () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      fireEvent.pointerDown(screen.getByText('task-123'), { pointerType: 'mouse', clientX: 60, clientY: 200 });
      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(writeText).not.toHaveBeenCalled();
    });

    it('falls back to execCommand when the clipboard api rejects (WebKit long-press)', async () => {
      writeText.mockRejectedValue(new Error('NotAllowedError'));
      const execCommand = vi.fn().mockReturnValue(true);
      document.execCommand = execCommand;

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      fireEvent.doubleClick(screen.getByText('task-123'), { clientX: 120, clientY: 80 });

      await waitFor(() => expect(execCommand).toHaveBeenCalledWith('copy'));
      expect(await screen.findByText('Copied')).toBeInTheDocument();
      // The temporary textarea must not be left behind in the DOM.
      expect(document.querySelectorAll('textarea')).toHaveLength(0);
    });

    it('surfaces a failure bubble instead of failing silently when every copy path fails', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      writeText.mockRejectedValue(new Error('NotAllowedError'));
      document.execCommand = vi.fn().mockReturnValue(false);

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      fireEvent.doubleClick(screen.getByText('task-123'), { clientX: 120, clientY: 80 });

      const bubble = await screen.findByRole('alert');
      expect(bubble).toHaveTextContent('Copy failed');
      expect(screen.queryByText('Copied')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.queryByText('Copy failed')).toBeNull();
    });

    it('copies the session id on double click', async () => {
      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      fireEvent.doubleClick(screen.getByText('session-xyz'), { clientX: 10, clientY: 10 });

      await waitFor(() => expect(writeText).toHaveBeenCalledWith('session-xyz'));
      expect(await screen.findByText('Copied')).toBeInTheDocument();
    });

    it('does not copy placeholder values', async () => {
      useRuntimeStoreMock.mockImplementation((selector: (state: { byTask: Record<string, unknown> }) => unknown) =>
        selector({ byTask: {} }),
      );
      useTasksStoreMock.mockImplementation((selector: (state: { tasks: Array<Record<string, unknown>> }) => unknown) =>
        selector({ tasks: [{ id: 'task-123' }] }),
      );

      render(<ConnectionStatus detailsEnabled />);
      fireEvent.click(screen.getByRole('button', { name: 'Open connection details' }));

      const copyableValues = document.querySelectorAll('[title="Double-click or long-press to copy"]');
      expect(copyableValues).toHaveLength(2);
      // index 1 is the Session ID value, which renders the "n/a" placeholder here
      expect(copyableValues[1].textContent).toBe('n/a');
      fireEvent.doubleClick(copyableValues[1], { clientX: 10, clientY: 10 });

      await Promise.resolve();
      expect(writeText).not.toHaveBeenCalled();
      expect(screen.queryByText('Copied')).toBeNull();
    });
  });
});

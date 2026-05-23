import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomCommandsPanel } from './CustomCommandsPanel';

const apiGetMock = vi.fn();
const apiPostMock = vi.fn();
const pushToastMock = vi.fn();

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: apiGetMock,
    post: apiPostMock,
  }),
}));

vi.mock('@/components/common/FeedbackProvider', () => ({
  useToast: () => ({
    pushToast: pushToastMock,
  }),
}));

describe('CustomCommandsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiGetMock.mockResolvedValue({ commands: [] });
    apiPostMock.mockResolvedValue({
      started: true,
      key: 'refresh-cache',
      runId: 'run-1',
      status: 'running',
      startedAt: '2026-05-23T00:00:00.000Z',
    });
  });

  it('does not fetch when daemon does not support custom commands', () => {
    render(<CustomCommandsPanel agentHost="daemon-a" supported={false} />);

    expect(screen.queryByRole('heading', { name: 'Custom Commands' })).not.toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it('hides the section when no commands are configured', async () => {
    render(<CustomCommandsPanel agentHost="daemon-a" supported />);

    await waitFor(() => {
      expect(apiGetMock).toHaveBeenCalledWith('/agents/daemon-a/custom-commands');
      expect(screen.queryByRole('heading', { name: 'Custom Commands' })).not.toBeInTheDocument();
    });
  });

  it('renders configured command keys without script paths', async () => {
    apiGetMock.mockResolvedValueOnce({
      commands: [{ key: 'refresh-cache', running: false }],
    });

    render(<CustomCommandsPanel agentHost="daemon-a" supported />);

    expect(await screen.findByText('refresh-cache')).toBeInTheDocument();
    expect(screen.queryByText(/scripts\/refresh-cache/)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Run custom command refresh-cache')).toBeEnabled();
  });

  it('starts a command and displays completed output from status polling', async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path.includes('/runs/run-1')) {
        return Promise.resolve({
          runId: 'run-1',
          key: 'refresh-cache',
          status: 'completed',
          exitCode: 0,
          stdoutTail: 'done\n',
          stderrTail: '',
          startedAt: '2026-05-23T00:00:00.000Z',
          finishedAt: '2026-05-23T00:00:01.000Z',
        });
      }
      return Promise.resolve({ commands: [{ key: 'refresh-cache', running: false }] });
    });

    render(<CustomCommandsPanel agentHost="daemon-a" supported />);

    fireEvent.click(await screen.findByLabelText('Run custom command refresh-cache'));

    await waitFor(() => {
      expect(apiPostMock).toHaveBeenCalledWith('/agents/daemon-a/custom-commands/run', {
        key: 'refresh-cache',
      });
      expect(apiGetMock).toHaveBeenCalledWith('/agents/daemon-a/custom-commands/runs/run-1');
      expect(screen.getByText('completed')).toBeInTheDocument();
      expect(screen.getByText(/done/)).toBeInTheDocument();
    });
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Command started',
      variant: 'success',
    }));
    expect(pushToastMock).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Command completed',
      variant: 'success',
    }));
  });

  describe('status polling cadence', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('polls running status on a fixed 2s interval (no tight loop while running)', async () => {
      // The bug we're guarding against: the poll effect's deps referenced
      // the per-poll mutated `runsByKey`, so every successful response
      // re-ran the effect and immediately re-polled — turning the 2s
      // interval into a tight loop. We confirm the cadence by counting
      // status fetches across a window of fake-timer ticks.
      const statusResponses = [
        {
          runId: 'run-1',
          key: 'refresh-cache',
          status: 'running',
          stdoutTail: 'line 1\n',
        },
        {
          runId: 'run-1',
          key: 'refresh-cache',
          status: 'running',
          stdoutTail: 'line 1\nline 2\n',
        },
        {
          runId: 'run-1',
          key: 'refresh-cache',
          status: 'running',
          stdoutTail: 'line 1\nline 2\nline 3\n',
        },
      ];
      let statusCallIndex = 0;
      apiGetMock.mockImplementation((path: string) => {
        if (path.includes('/runs/run-1')) {
          const payload = statusResponses[Math.min(statusCallIndex, statusResponses.length - 1)];
          statusCallIndex += 1;
          return Promise.resolve(payload);
        }
        return Promise.resolve({ commands: [{ key: 'refresh-cache', running: false }] });
      });

      render(<CustomCommandsPanel agentHost="daemon-a" supported />);

      fireEvent.click(await screen.findByLabelText('Run custom command refresh-cache'));

      // Drain initial poll triggered immediately after the run starts.
      await waitFor(() => {
        expect(statusCallIndex).toBeGreaterThanOrEqual(1);
      });
      const initialCalls = statusCallIndex;

      // Advance ~2s of fake time; expect exactly one additional poll.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(statusCallIndex).toBe(initialCalls + 1);

      // Another ~2s tick → one more poll, not many.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(statusCallIndex).toBe(initialCalls + 2);

      // And nothing extra fires inside a single tick window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(statusCallIndex).toBe(initialCalls + 2);
    });
  });
});

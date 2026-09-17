import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPLY_IN_PROGRESS_WATCHDOG_MS, useRuntimeStore } from './runtime-store';

const apiPostMock = vi.hoisted(() => vi.fn());

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({ post: apiPostMock }),
}));

const TASK = 'task-watchdog-1';

function replying(taskId: string, statusLine = 'codex composing reply') {
  useRuntimeStore.getState().setStatus({
    taskId,
    replyInProgress: true,
    statusLine,
  });
}

describe('runtime store stuck-composer watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiPostMock.mockReset();
    apiPostMock.mockResolvedValue({ requested: true });
    useRuntimeStore.getState().clearAll();
  });

  afterEach(() => {
    useRuntimeStore.getState().clearAll();
    vi.useRealTimers();
  });

  it('asks the fire to re-report instead of clearing a silent reply', () => {
    replying(TASK);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);

    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);

    // A long tool can be silent for minutes: keep the reply alive.
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
    expect(apiPostMock).toHaveBeenCalledWith(`/tasks/${TASK}/runtime-status`);

    // Still silent: keep asking every window.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(apiPostMock).toHaveBeenCalledTimes(2);

    // The fire's settled frame is what clears the composer.
    useRuntimeStore.getState().setStatus({ taskId: TASK, replyInProgress: false, statusDoneLine: 'codex finished' });
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(false);
    expect(apiPostMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the composer busy while status frames keep arriving', () => {
    replying(TASK);
    // Activity just before the deadline resets the timer.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);
    replying(TASK, 'codex running command');
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);

    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();

    // Once the stream goes silent, the watchdog eventually fires.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(apiPostMock).toHaveBeenCalledTimes(1);
  });

  it('cancels the watchdog when a real terminal clear arrives', () => {
    replying(TASK);
    useRuntimeStore.getState().setStatus({
      taskId: TASK,
      replyInProgress: false,
      statusDoneLine: 'codex finished',
    });

    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);

    const status = useRuntimeStore.getState().byTask[TASK];
    expect(status?.replyInProgress).toBe(false);
    expect(status?.statusDoneLine).toBe('codex finished');
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('noteActivity re-arms while replying but never resurrects a settled reply', () => {
    replying(TASK);
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);
    useRuntimeStore.getState().noteActivity(TASK);
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);
    expect(apiPostMock).not.toHaveBeenCalled();

    // Once settled, a late message must not re-arm the watchdog.
    useRuntimeStore.getState().setStatus({ taskId: TASK, replyInProgress: false });
    useRuntimeStore.getState().noteActivity(TASK);
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(apiPostMock).not.toHaveBeenCalled();
  });

  it('clearTask cancels the pending watchdog', () => {
    replying(TASK);
    useRuntimeStore.getState().clearTask(TASK);
    // Should not throw or recreate the entry.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(useRuntimeStore.getState().byTask[TASK]).toBeUndefined();
    expect(apiPostMock).not.toHaveBeenCalled();
  });
});

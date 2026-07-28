import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REPLY_IN_PROGRESS_WATCHDOG_MS, useRuntimeStore } from './runtime-store';

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
    useRuntimeStore.getState().clearAll();
  });

  afterEach(() => {
    useRuntimeStore.getState().clearAll();
    vi.useRealTimers();
  });

  it('clears replyInProgress after the idle window when the terminal clear is lost', () => {
    replying(TASK);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);

    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);

    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(false);
  });

  it('keeps the composer busy while status frames keep arriving', () => {
    replying(TASK);
    // Activity just before the deadline resets the timer.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);
    replying(TASK, 'codex running command');
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);

    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);

    // Once the stream goes silent, the watchdog eventually fires.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(false);
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
  });

  it('noteActivity re-arms while replying but never resurrects a cleared watchdog', () => {
    replying(TASK);
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);
    useRuntimeStore.getState().noteActivity(TASK);
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS - 10);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(true);

    // Let it fire, then a late message must not re-arm a cleared task.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(false);
    useRuntimeStore.getState().noteActivity(TASK);
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(useRuntimeStore.getState().byTask[TASK]?.replyInProgress).toBe(false);
  });

  it('clearTask cancels the pending watchdog', () => {
    replying(TASK);
    useRuntimeStore.getState().clearTask(TASK);
    // Should not throw or recreate the entry.
    vi.advanceTimersByTime(REPLY_IN_PROGRESS_WATCHDOG_MS + 1);
    expect(useRuntimeStore.getState().byTask[TASK]).toBeUndefined();
  });
});

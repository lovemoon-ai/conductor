import { create } from 'zustand';
import { getApiClient } from '@/shared/api/client';
import type { TaskRuntimeStatus } from '@/shared/types';

interface RuntimeState {
  byTask: Record<string, TaskRuntimeStatus>;
  setStatus: (status: TaskRuntimeStatus) => void;
  /** Reset the stuck-composer watchdog for a task (e.g. on a new message). */
  noteActivity: (taskId: string) => void;
  clearTask: (taskId: string) => void;
  clearAll: () => void;
}

/**
 * Stuck-composer watchdog (defense-in-depth for the P2 / BUG-R6-01 class of
 * bug). The composer's interrupt/send mode is driven purely by
 * `replyInProgress`. If a backend's terminal "reply_in_progress:false" clear is
 * ever lost — the session never emits it, or a realtime frame is dropped in
 * transit — the composer stays stuck on "…composing reply" until the backend's
 * 12-minute idle deadline fires or the user reloads the page.
 *
 * Silence is not proof the turn is dead: a tool can run for many minutes
 * without output. So if a task sits in `replyInProgress` with zero further
 * activity (status updates OR messages) for the timeout window, we ask the
 * task's fire to re-report instead of clearing locally. A running turn answers
 * with a heartbeat (current tool + elapsed time), a settled one with
 * `reply_in_progress: false`; a dead fire is converged by stale-task recovery.
 * Fire also heartbeats every 60s of silence, so this rarely fires.
 */
export const REPLY_IN_PROGRESS_WATCHDOG_MS = 120_000;

const watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Ask the task's fire to re-report its runtime status (best effort). */
export function requestTaskRuntimeStatus(taskId: string): void {
  void getApiClient()
    .post(`/tasks/${taskId}/runtime-status`)
    .catch(() => {
      // The task may have stopped or its fire may be offline; nothing to do.
    });
}

function cancelWatchdog(taskId: string): void {
  const timer = watchdogTimers.get(taskId);
  if (timer !== undefined) {
    clearTimeout(timer);
    watchdogTimers.delete(taskId);
  }
}

function cancelAllWatchdogs(): void {
  for (const timer of watchdogTimers.values()) {
    clearTimeout(timer);
  }
  watchdogTimers.clear();
}

const mergeRuntimeStatus = (
  existing: TaskRuntimeStatus | undefined,
  incoming: TaskRuntimeStatus,
): TaskRuntimeStatus => ({
  taskId: incoming.taskId,
  state: incoming.state,
  phase: incoming.phase,
  source: incoming.source ?? existing?.source,
  replyInProgress: incoming.replyInProgress,
  statusLine: incoming.statusLine,
  statusDoneLine: incoming.statusDoneLine,
  replyPreview: incoming.replyPreview,
  replyTo: incoming.replyTo,
  backend: incoming.backend ?? existing?.backend,
  threadId: incoming.threadId ?? existing?.threadId,
  daemon: incoming.daemon ?? existing?.daemon,
  pid: incoming.pid ?? existing?.pid,
  sessionId: incoming.sessionId ?? existing?.sessionId,
  sessionFilePath: incoming.sessionFilePath ?? existing?.sessionFilePath,
  tokenUsagePercent: incoming.tokenUsagePercent ?? existing?.tokenUsagePercent,
  contextUsagePercent: incoming.contextUsagePercent ?? existing?.contextUsagePercent,
  // aiMode flips per-turn (user can type `/goal ...` mid-chat) so we always
  // honor the incoming value when fire reports one, and fall back to the
  // previous mode otherwise. We deliberately do NOT clear it on a status
  // without `aiMode` — the field is sticky across non-dispatch events (e.g.
  // status-line updates) so the UI does not flicker between modes.
  aiMode: incoming.aiMode ?? existing?.aiMode,
  createdAt: incoming.createdAt ?? existing?.createdAt,
});

export const useRuntimeStore = create<RuntimeState>()((set, get) => {
  const armWatchdog = (taskId: string) => {
    cancelWatchdog(taskId);
    const timer = setTimeout(() => {
      watchdogTimers.delete(taskId);
      if (!get().byTask[taskId]?.replyInProgress) {
        return;
      }
      requestTaskRuntimeStatus(taskId);
      armWatchdog(taskId);
    }, REPLY_IN_PROGRESS_WATCHDOG_MS);
    // Node's timers expose unref(); browsers do not. Never block process exit.
    (timer as { unref?: () => void }).unref?.();
    watchdogTimers.set(taskId, timer);
  };

  return {
    byTask: {},

    setStatus: (status) => {
      if (!status?.taskId) {
        return;
      }
      set((state) => ({
        byTask: {
          ...state.byTask,
          [status.taskId]: mergeRuntimeStatus(state.byTask[status.taskId], status),
        },
      }));
      if (status.replyInProgress) {
        armWatchdog(status.taskId);
      } else {
        cancelWatchdog(status.taskId);
      }
    },

    noteActivity: (taskId) => {
      if (!taskId) {
        return;
      }
      // Only re-arm if the task is still believed to be replying; otherwise a
      // stray message must not resurrect a cleared watchdog.
      if (get().byTask[taskId]?.replyInProgress) {
        armWatchdog(taskId);
      }
    },

    clearTask: (taskId) => {
      if (!taskId) {
        return;
      }
      cancelWatchdog(taskId);
      set((state) => {
        const { [taskId]: _ignored, ...rest } = state.byTask;
        return { byTask: rest };
      });
    },

    clearAll: () => {
      cancelAllWatchdogs();
      set({ byTask: {} });
    },
  };
});

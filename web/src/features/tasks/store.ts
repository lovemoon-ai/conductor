import { create } from 'zustand';
import type {
  Task,
  CreateTaskInput,
  RestartTaskResponse,
  RestartTaskInput,
  UpdateTaskInput,
  CleanupTaskWorktreeResponse,
} from '@/shared/types';
import { getApiClient } from '@/shared/api/client';
import { usePtyToggleStore } from './pty-toggle-store';

let fetchTasksRequestSequence = 0;

const normalizeObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const normalizePtySession = (value: any) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return {
    id: value.id,
    taskId: value.taskId ?? value.task_id,
    state: value.state,
    entrypointType: value.entrypointType ?? value.entrypoint_type ?? null,
    toolPreset: value.toolPreset ?? value.tool_preset ?? null,
    command: normalizeObject(value.command),
    cwd: value.cwd ?? null,
    env: normalizeObject(value.env),
    shell: value.shell ?? null,
    pid: value.pid ?? null,
    cols: value.cols ?? null,
    rows: value.rows ?? null,
    lastOutputSeq: value.lastOutputSeq ?? value.last_output_seq ?? 0,
    startedAt: value.startedAt ?? value.started_at ?? null,
    closedAt: value.closedAt ?? value.closed_at ?? null,
    createdAt: value.createdAt ?? value.created_at ?? undefined,
    updatedAt: value.updatedAt ?? value.updated_at ?? null,
  };
};

const normalizeTaskStatus = (value: unknown): Task['status'] => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'init') {
    return 'init';
  }
  if (normalized === 'running') {
    return 'running';
  }
  if (normalized === 'killing' || normalized === 'stopping') {
    return 'killing';
  }
  if (normalized === 'completed') {
    return 'completed';
  }
  if (normalized === 'killed' || normalized === 'failed' || normalized === 'cancelled') {
    return 'killed';
  }
  return 'unknown';
};

interface TasksState {
  tasks: Task[];
  isLoading: boolean;
  error: string | null;
  currentProjectFilter: string | null;
  /**
   * When the active project view is a cross-daemon merged group, this holds
   * the full set of project ids the task list is fetching for (in member
   * order). Empty when only `currentProjectFilter` is in use.
   */
  currentProjectIds: string[];
  unreadTaskIds: Set<string>;

  // Actions
  fetchTasks: (projectId?: string, options?: { recoverStale?: boolean }) => Promise<void>;
  /**
   * Fetch tasks across multiple projects in a single call — used by the
   * merged cross-daemon view so the list combines tasks from every daemon's
   * same-named project. Pass an empty list to fall back to the unfiltered
   * "all tasks" view.
   */
  fetchTasksForProjects: (projectIds: string[], options?: { recoverStale?: boolean }) => Promise<void>;
  fetchTask: (taskId: string) => Promise<Task | null>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  updateTask: (taskId: string, input: UpdateTaskInput) => Promise<Task>;
  restartTask: (taskId: string, input?: RestartTaskInput) => Promise<RestartTaskResponse>;
  cleanupTaskWorktree: (taskId: string) => Promise<CleanupTaskWorktreeResponse>;
  deleteTask: (taskId: string) => Promise<void>;
  setProjectFilter: (projectId: string | null) => void;
  /**
   * Set the active project filter to a merged cross-daemon group and fetch
   * the combined task list. An empty / single-id list is treated the same as
   * `setProjectFilter`.
   */
  setProjectGroupFilter: (projectIds: string[]) => void;
  markTaskRead: (taskId: string) => void;
  markTaskUnread: (taskId: string) => void;
  updateTaskInList: (task: Task, options?: { moveToFront?: boolean }) => void;
  removeTask: (taskId: string) => void;
  clearError: () => void;
}

const normalizeProjectIdList = (projectIds: string[]): string[] =>
  Array.from(new Set(projectIds.flatMap((id) => {
    const trimmed = id.trim();
    return trimmed ? [trimmed] : [];
  })));

const projectScopeKey = (projectIds: string[]): string =>
  normalizeProjectIdList(projectIds).slice().sort().join(',');

const normalizeAttachedTerminal = (raw: any): Task['attachedTerminal'] => {
  const value = raw ?? null;
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : null;
  const ptyTaskId =
    typeof value.ptyTaskId === 'string'
      ? value.ptyTaskId
      : typeof value.pty_task_id === 'string'
        ? value.pty_task_id
        : null;
  if (!id || !ptyTaskId) return null;
  const rawStatus =
    typeof value.ptyTaskStatus === 'string'
      ? value.ptyTaskStatus
      : typeof value.pty_task_status === 'string'
        ? value.pty_task_status
        : null;
  return {
    id,
    ptyTaskId,
    ptyTaskStatus: rawStatus ? normalizeTaskStatus(rawStatus) : null,
  };
};

export const normalizeTask = (task: any): Task => ({
  id: task.id,
  projectId: task.projectId ?? task.project_id ?? null,
  issueId: task.issueId ?? task.issue_id ?? null,
  title: task.title,
  taskType: task.taskType ?? task.task_type ?? 'ai_task',
  status: normalizeTaskStatus(task.status),
  agentHost: task.agentHost ?? task.agent_host ?? null,
  executionHost: task.executionHost ?? task.execution_host ?? null,
  backendType: task.backendType ?? task.backend_type ?? null,
  sessionId: task.sessionId ?? task.session_id ?? null,
  sessionFilePath: task.sessionFilePath ?? task.session_file_path ?? null,
  launchConfig: normalizeObject(task.launchConfig ?? task.launch_config),
  metadata: normalizeObject(task.metadata),
  lastUserMessage: task.lastUserMessage ?? task.last_user_message ?? null,
  lastAssistantMessage: task.lastAssistantMessage ?? task.last_assistant_message ?? null,
  ptySession: normalizePtySession(task.ptySession ?? task.pty_session),
  attachedTerminal: normalizeAttachedTerminal(task.attachedTerminal ?? task.attached_terminal),
  activeScheduledMessageCount:
    typeof task.activeScheduledMessageCount === 'number'
      ? Math.max(0, task.activeScheduledMessageCount)
      : typeof task.active_scheduled_message_count === 'number'
        ? Math.max(0, task.active_scheduled_message_count)
        : 0,
  createdAt: task.createdAt ?? task.created_at ?? new Date().toISOString(),
  updatedAt: task.updatedAt ?? task.updated_at ?? null,
});

export const getTaskPinnedAtTime = (task: { metadata?: Record<string, unknown> | null }): number | null => {
  const value = task.metadata?.pinnedAt;
  if (typeof value !== 'string') {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

export const orderTasksWithPinnedFirst = <T extends { metadata?: Record<string, unknown> | null }>(tasks: T[]): T[] =>
  tasks
    .map((task, index) => ({
      task,
      index,
      pinnedAt: getTaskPinnedAtTime(task),
    }))
    .sort((left, right) => {
      if (left.pinnedAt !== null && right.pinnedAt !== null) {
        const pinnedDelta = right.pinnedAt - left.pinnedAt;
        return pinnedDelta !== 0 ? pinnedDelta : left.index - right.index;
      }
      if (left.pinnedAt !== null) {
        return -1;
      }
      if (right.pinnedAt !== null) {
        return 1;
      }
      return left.index - right.index;
    })
    .map(({ task }) => task);

const mergeMutationTask = (existing: Task | undefined, incoming: Task): Task => {
  if (!existing || incoming.status !== 'init' || existing.status === 'init') {
    return incoming;
  }

  return {
    ...incoming,
    status: existing.status,
    agentHost: existing.agentHost ?? incoming.agentHost,
    executionHost: existing.executionHost ?? incoming.executionHost,
    sessionId: existing.sessionId ?? incoming.sessionId,
    sessionFilePath: existing.sessionFilePath ?? incoming.sessionFilePath,
    lastUserMessage: existing.lastUserMessage ?? incoming.lastUserMessage,
    lastAssistantMessage: existing.lastAssistantMessage ?? incoming.lastAssistantMessage,
    updatedAt: existing.updatedAt ?? incoming.updatedAt,
  };
};

const upsertTask = (tasks: Task[], task: Task, options?: { moveToFront?: boolean }): Task[] => {
  const index = tasks.findIndex((existing) => existing.id === task.id);
  if (index === -1) {
    return orderTasksWithPinnedFirst([task, ...tasks]);
  }

  if (options?.moveToFront) {
    return orderTasksWithPinnedFirst([task, ...tasks.slice(0, index), ...tasks.slice(index + 1)]);
  }

  const next = [...tasks];
  next[index] = task;
  return orderTasksWithPinnedFirst(next);
};

export const useTasksStore = create<TasksState>()((set, get) => {
  const syncTask = (task: Task, options?: { moveToFront?: boolean }) => {
    set((state) => {
      // Root-cause guard: never let an attached PTY task enter the top-level
      // task list. Two complementary signals catch this in any race order:
      //   (a) The PTY task's own metadata carries `attachedToAiTaskId` set
      //       by createAttachedTerminalRecord; this works even when the AI
      //       task hasn't loaded yet (e.g., WebSocket `task_status_update`
      //       arrives before the initial list fetch completes).
      //   (b) Some AI task already in the store claims this PTY via its
      //       attachedTerminal field; covers legacy PTY tasks that predate
      //       the metadata stamp.
      // The attached PTY task is hydrated inside its AI task's detail pane
      // via a local `api.get` call instead of going through this store.
      if (task.taskType === 'pty_task') {
        const ownMetadataClaims =
          typeof (task.metadata as { attachedToAiTaskId?: unknown })?.attachedToAiTaskId === 'string';
        const claimedByExistingAi = state.tasks.some(
          (existing) => existing.attachedTerminal?.ptyTaskId === task.id,
        );
        if (ownMetadataClaims || claimedByExistingAi) {
          return { error: null } as Partial<TasksState>;
        }
      }
      return {
        tasks: upsertTask(state.tasks, task, options),
        error: null,
      };
    });
  };

  const fetchTaskStrict = async (taskId: string) => {
    const api = getApiClient();
    const task = normalizeTask(await api.get<Task>(`/tasks/${taskId}?recover_stale=1`));
    syncTask(task);
    return task;
  };

  return ({
    tasks: [],
    isLoading: false,
    error: null,
    currentProjectFilter: null,
    currentProjectIds: [],
    unreadTaskIds: new Set(),

    fetchTasks: async (projectId, options) => {
      const requestId = ++fetchTasksRequestSequence;
      const requestedProjectId = projectId ?? null;
      set({ isLoading: true, error: null });
      try {
        const api = getApiClient();
        const query = new URLSearchParams();
        const recoverStale = options?.recoverStale ?? true;
        if (projectId) {
          query.set('project_id', projectId);
        }
        if (recoverStale) {
          query.set('recover_stale', '1');
        }
        const suffix = query.toString() ? `?${query.toString()}` : '';
        const tasksPromise = api.get<Task[]>(`/tasks${suffix}`);
        if (
          get().currentProjectFilter !== requestedProjectId
          || get().currentProjectIds.length !== 0
          || requestId !== fetchTasksRequestSequence
        ) {
          tasksPromise.catch(() => {});
          return;
        }
        const tasks = await tasksPromise;
        if (
          get().currentProjectFilter !== requestedProjectId
          || get().currentProjectIds.length !== 0
          || requestId !== fetchTasksRequestSequence
        ) {
          return;
        }
        set({ tasks: orderTasksWithPinnedFirst(tasks.map(normalizeTask)), isLoading: false });
      } catch (error) {
        if (
          get().currentProjectFilter !== requestedProjectId
          || get().currentProjectIds.length !== 0
          || requestId !== fetchTasksRequestSequence
        ) {
          return;
        }
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to fetch tasks',
        });
      }
    },

    fetchTasksForProjects: async (projectIds, options) => {
      const normalized = normalizeProjectIdList(projectIds);
      // Empty list ⇒ defer to fetchTasks with no project filter so callers can
      // unwind the merged scope without a second API call shape.
      if (normalized.length === 0) {
        await get().fetchTasks(undefined, options);
        return;
      }
      // Single id ⇒ keep the lighter `project_id` path on the backend; the
      // merged store fields are cleared to match.
      if (normalized.length === 1) {
        set({ currentProjectFilter: normalized[0], currentProjectIds: [] });
        await get().fetchTasks(normalized[0], options);
        return;
      }
      const requestId = ++fetchTasksRequestSequence;
      const requestedKey = projectScopeKey(normalized);
      set({ isLoading: true, error: null, currentProjectFilter: null, currentProjectIds: normalized });
      try {
        const api = getApiClient();
        const query = new URLSearchParams();
        const recoverStale = options?.recoverStale ?? true;
        query.set('project_ids', normalized.join(','));
        if (recoverStale) {
          query.set('recover_stale', '1');
        }
        const suffix = `?${query.toString()}`;
        const tasksPromise = api.get<Task[]>(`/tasks${suffix}`);
        if (
          projectScopeKey(get().currentProjectIds) !== requestedKey
          || requestId !== fetchTasksRequestSequence
        ) {
          tasksPromise.catch(() => {});
          return;
        }
        const tasks = await tasksPromise;
        if (
          projectScopeKey(get().currentProjectIds) !== requestedKey
          || requestId !== fetchTasksRequestSequence
        ) {
          return;
        }
        set({ tasks: orderTasksWithPinnedFirst(tasks.map(normalizeTask)), isLoading: false });
      } catch (error) {
        if (
          projectScopeKey(get().currentProjectIds) !== requestedKey
          || requestId !== fetchTasksRequestSequence
        ) {
          return;
        }
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to fetch tasks',
        });
      }
    },

    fetchTask: async (taskId) => {
      try {
        const task = await fetchTaskStrict(taskId);
        return task;
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to fetch task',
        });
        return null;
      }
    },

    createTask: async (input) => {
      set({ isLoading: true, error: null });
      try {
        const api = getApiClient();
        const incomingTask = normalizeTask(await api.post<Task>('/tasks', input));
        const task = mergeMutationTask(get().tasks.find((current) => current.id === incomingTask.id), incomingTask);
        set((state) => ({
          tasks: upsertTask(state.tasks, task),
          isLoading: false,
        }));
        if (incomingTask.status === 'init') {
          void get().fetchTask(incomingTask.id);
        }
        return task;
      } catch (error) {
        set({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to create task',
        });
        throw error;
      }
    },

    updateTask: async (taskId, input) => {
      try {
        const api = getApiClient();
        const task = normalizeTask(await api.patch<Task>(`/tasks/${taskId}`, input));
        set((state) => ({
          tasks: upsertTask(state.tasks, task),
        }));
        return task;
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to update task',
        });
        throw error;
      }
    },

    restartTask: async (taskId, input) => {
      try {
        const api = getApiClient();
        const body: Record<string, unknown> = {};
        if (typeof input?.backendType === 'string' && input.backendType.trim()) {
          body.backend_type = input.backendType.trim();
        }
        if (typeof input?.strategy === 'string' && input.strategy.trim()) {
          body.strategy = input.strategy.trim();
        }
        if (typeof input?.restartMode === 'string' && input.restartMode.trim()) {
          body.restart_mode = input.restartMode.trim();
        }
        const response = await api.post<{
          mode: RestartTaskResponse['mode'];
          source_task_id: string;
          task: Task;
        }>(`/tasks/${taskId}/restart`, body);
        const incomingTask = normalizeTask(response.task);
        const task = mergeMutationTask(get().tasks.find((current) => current.id === incomingTask.id), incomingTask);
        set((state) => ({
          tasks: upsertTask(state.tasks, task, { moveToFront: true }),
        }));
        if (incomingTask.status === 'init') {
          void get().fetchTask(incomingTask.id);
        }
        return {
          mode: response.mode,
          sourceTaskId: response.source_task_id,
          task,
        };
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to restart task',
        });
        throw error;
      }
    },

    cleanupTaskWorktree: async (taskId) => {
      try {
        const api = getApiClient();
        const response = await api.post<{
          task: Task;
          cleaned_at: string;
          removed_path?: string | null;
          worktree_branch?: string | null;
        }>(`/tasks/${taskId}/worktree`);
        const task = normalizeTask(response.task);
        set((state) => ({
          tasks: upsertTask(state.tasks, task),
        }));
        return {
          task,
          cleanedAt: response.cleaned_at,
          removedPath: response.removed_path ?? null,
          worktreeBranch: response.worktree_branch ?? null,
        };
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to remove task worktree',
        });
        throw error;
      }
    },

    deleteTask: async (taskId) => {
      try {
        const api = getApiClient();
        await api.delete(`/tasks/${taskId}`);
        // Route through `removeTask` so the attached-terminal cleanup
        // (clearing the owning AI task's `attachedTerminal` field + the
        // PTY toggle visibility flag) fires for both code paths. Without
        // this, deleting the PTY task from TerminalView's toolbar leaves
        // the AI card showing a stale PTY chip until the next list fetch.
        get().removeTask(taskId);
      } catch (error) {
        set({
          error: error instanceof Error ? error.message : 'Failed to delete task',
        });
        throw error;
      }
    },

    setProjectFilter: (projectId) => {
      // Clearing `currentProjectIds` here is what makes a merged-group →
      // single-project switch race-safe: the in-flight `fetchTasksForProjects`
      // response checks `currentProjectIds` and bails out when it no longer
      // matches, instead of clobbering the new single-project payload.
      set({ currentProjectFilter: projectId, currentProjectIds: [] });
      get().fetchTasks(projectId ?? undefined);
    },

    setProjectGroupFilter: (projectIds) => {
      const normalized = normalizeProjectIdList(projectIds);
      if (normalized.length <= 1) {
        // Single (or zero) member ⇒ behave exactly like setProjectFilter so
        // we keep the historical single-id query path / state shape.
        const single = normalized[0] ?? null;
        set({ currentProjectFilter: single, currentProjectIds: [] });
        get().fetchTasks(single ?? undefined);
        return;
      }
      void get().fetchTasksForProjects(normalized);
    },

    markTaskRead: (taskId) => {
      set((state) => {
        const newUnread = new Set(state.unreadTaskIds);
        newUnread.delete(taskId);
        return { unreadTaskIds: newUnread };
      });
    },

    markTaskUnread: (taskId) => {
      set((state) => ({
        unreadTaskIds: new Set([...state.unreadTaskIds, taskId]),
      }));
    },

    updateTaskInList: (task, options) => {
      set((state) => ({
        tasks: upsertTask(state.tasks, normalizeTask(task), options),
      }));
    },

    removeTask: (taskId) => {
      if (!taskId) {
        return;
      }
      // Compute the owning AI task id BEFORE the set() call so the cross-
      // store toggle clear can happen OUTSIDE the reducer body (keeps the
      // zustand reducer pure — no localStorage side effects from inside
      // set callbacks that React strict-mode could double-invoke).
      const owningAiTaskId =
        get().tasks.find((t) => t.attachedTerminal?.ptyTaskId === taskId)?.id ?? null;
      set((state) => {
        let nextTasks = state.tasks.filter((task) => task.id !== taskId);
        if (owningAiTaskId) {
          // Clear the owning AI task's `attachedTerminal` so its PTY toggle
          // chip disappears immediately — without this, deleting the PTY
          // from TerminalView's toolbar leaves a stale "PTY visible" chip
          // on the AI task card until the next list refresh.
          nextTasks = nextTasks.map((t) =>
            t.id === owningAiTaskId ? { ...t, attachedTerminal: null } : t,
          );
        }
        return {
          tasks: nextTasks,
          unreadTaskIds: new Set([...state.unreadTaskIds].filter((id) => id !== taskId)),
        };
      });
      // Side effects (localStorage writes via the toggle store) are kept
      // OUTSIDE the reducer.
      if (owningAiTaskId) {
        usePtyToggleStore.getState().clear(owningAiTaskId);
      }
      // Drop any per-task UI state keyed on this id so a future task with
      // the same id (unlikely but possible after a self-host reset) doesn't
      // inherit a stale "PTY visible" toggle.
      usePtyToggleStore.getState().clear(taskId);
    },

    clearError: () => set({ error: null }),
  });
});

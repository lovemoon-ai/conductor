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
  unreadTaskIds: Set<string>;

  // Actions
  fetchTasks: (projectId?: string, options?: { recoverStale?: boolean }) => Promise<void>;
  fetchTask: (taskId: string) => Promise<Task | null>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  updateTask: (taskId: string, input: UpdateTaskInput) => Promise<Task>;
  restartTask: (taskId: string, input?: RestartTaskInput) => Promise<RestartTaskResponse>;
  cleanupTaskWorktree: (taskId: string) => Promise<CleanupTaskWorktreeResponse>;
  deleteTask: (taskId: string) => Promise<void>;
  setProjectFilter: (projectId: string | null) => void;
  markTaskRead: (taskId: string) => void;
  markTaskUnread: (taskId: string) => void;
  updateTaskInList: (task: Task, options?: { moveToFront?: boolean }) => void;
  removeTask: (taskId: string) => void;
  clearError: () => void;
}

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
  createdAt: task.createdAt ?? task.created_at ?? new Date().toISOString(),
  updatedAt: task.updatedAt ?? task.updated_at ?? null,
});

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
    return [task, ...tasks];
  }

  if (options?.moveToFront) {
    return [task, ...tasks.slice(0, index), ...tasks.slice(index + 1)];
  }

  const next = [...tasks];
  next[index] = task;
  return next;
};

export const useTasksStore = create<TasksState>()((set, get) => ({
  tasks: [],
  isLoading: false,
  error: null,
  currentProjectFilter: null,
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
      const tasks = await api.get<Task[]>(`/tasks${suffix}`);
      if (get().currentProjectFilter !== requestedProjectId || requestId !== fetchTasksRequestSequence) {
        return;
      }
      set({ tasks: tasks.map(normalizeTask), isLoading: false });
    } catch (error) {
      if (get().currentProjectFilter !== requestedProjectId || requestId !== fetchTasksRequestSequence) {
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
      const api = getApiClient();
      const task = normalizeTask(await api.get<Task>(`/tasks/${taskId}?recover_stale=1`));
      set((state) => ({
        tasks: upsertTask(state.tasks, task),
        error: null,
      }));
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
      set((state) => ({
        tasks: state.tasks.filter((t) => t.id !== taskId),
        unreadTaskIds: new Set([...state.unreadTaskIds].filter((id) => id !== taskId)),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete task',
      });
      throw error;
    }
  },

  setProjectFilter: (projectId) => {
    set({ currentProjectFilter: projectId });
    get().fetchTasks(projectId ?? undefined);
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
    set((state) => ({
      tasks: state.tasks.filter((task) => task.id !== taskId),
      unreadTaskIds: new Set([...state.unreadTaskIds].filter((id) => id !== taskId)),
    }));
  },

  clearError: () => set({ error: null }),
}));

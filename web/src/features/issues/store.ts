import { create } from 'zustand';
import type {
  CreateIssueInput,
  Issue,
  UpdateIssueInput,
  Task,
} from '@/shared/types';
import { getApiClient } from '@/shared/api/client';
import { ISSUE_STATUSES, normalizeIssuePriority, normalizeIssueStatus } from '@/lib/issues/config';
import { normalizeTask, useTasksStore } from '@/features/tasks/store';

const pickString = (value: unknown): string | null => {
  if (typeof value !== 'string') {
    return null;
  }
  return value;
};

const pickNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const normalizeObject = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const syncTask = (raw: unknown, moveToFront = false): Task | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const task = normalizeTask(raw);
  useTasksStore.getState().updateTaskInList(task, { moveToFront });
  return task;
};

const normalizeTaskList = (value: unknown): Task[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: Task[] = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      normalized.push(normalizeTask(entry));
    }
  }
  return normalized;
};

export const normalizeIssue = (raw: unknown): Issue | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const id = pickString(record.id);
  const projectId = pickString(record.projectId) ?? pickString(record.project_id);
  const title = pickString(record.title);
  const position = pickNumber(record.position);
  if (!id || !projectId || !title || position === null) {
    return null;
  }

  return {
    id,
    projectId,
    title,
    description: pickString(record.description),
    status: normalizeIssueStatus(record.status),
    priority: normalizeIssuePriority(record.priority),
    position,
    metadata: normalizeObject(record.metadata),
    activeTask: record.activeTask || record.active_task ? normalizeTask(record.activeTask ?? record.active_task) : null,
    linkedTask: record.linkedTask || record.linked_task
      ? normalizeTask(record.linkedTask ?? record.linked_task)
      : (record.activeTask || record.active_task ? normalizeTask(record.activeTask ?? record.active_task) : null),
    tasks: normalizeTaskList(record.tasks),
    createdAt:
      pickString(record.createdAt) ?? pickString(record.created_at) ?? new Date().toISOString(),
    updatedAt:
      pickString(record.updatedAt) ?? pickString(record.updated_at) ?? null,
  };
};

const normalizeIssueList = (raw: unknown): Issue[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => normalizeIssue(entry))
    .filter((issue): issue is Issue => issue !== null);
};

const sortIssues = (issues: Issue[]): Issue[] => {
  const statusOrder = new Map(ISSUE_STATUSES.map((status, index) => [status, index]));

  return issues.slice().sort((left, right) => {
    const leftStatus = statusOrder.get(normalizeIssueStatus(left.status)) ?? Number.MAX_SAFE_INTEGER;
    const rightStatus = statusOrder.get(normalizeIssueStatus(right.status)) ?? Number.MAX_SAFE_INTEGER;
    if (leftStatus !== rightStatus) {
      return leftStatus - rightStatus;
    }
    if (left.position !== right.position) {
      return left.position - right.position;
    }
    const leftUpdatedAt = Date.parse(left.updatedAt ?? left.createdAt);
    const rightUpdatedAt = Date.parse(right.updatedAt ?? right.createdAt);
    return rightUpdatedAt - leftUpdatedAt;
  });
};

const normalizeIssueMutationResponse = (raw: unknown): {
  issue: Issue | null;
  activeTask: Task | null;
  linkedTask: Task | null;
  spawnedTask: Task | null;
  killedTask: Task | null;
} => {
  if (!raw || typeof raw !== 'object') {
    return { issue: null, activeTask: null, linkedTask: null, spawnedTask: null, killedTask: null };
  }

  const record = raw as Record<string, unknown>;
  const issue = normalizeIssue(record.issue ?? raw);
  const activeTask = syncTask(record.activeTask ?? record.active_task, false);
  const linkedTask = syncTask(record.linkedTask ?? record.linked_task, false);
  const spawnedTask = syncTask(record.spawnedTask ?? record.spawned_task, true);
  const killedTask = syncTask(record.killedTask ?? record.killed_task, false);

  return { issue, activeTask, linkedTask, spawnedTask, killedTask };
};

const upsertIssue = (issues: Issue[], issue: Issue): Issue[] => {
  const index = issues.findIndex((current) => current.id === issue.id);
  if (index === -1) {
    return sortIssues([issue, ...issues]);
  }
  const next = [...issues];
  next[index] = issue;
  return sortIssues(next);
};

interface IssuesState {
  issues: Issue[];
  isLoading: boolean;
  error: string | null;
  currentProjectId: string | null;
  fetchIssues: (projectId?: string | null) => Promise<void>;
  createIssue: (input: CreateIssueInput) => Promise<Issue>;
  updateIssue: (issueId: string, input: UpdateIssueInput) => Promise<Issue>;
  moveIssue: (issueId: string, status: Issue['status'], position: number) => Promise<Issue>;
  deleteIssue: (issueId: string) => Promise<void>;
  clearError: () => void;
}

export const useIssuesStore = create<IssuesState>()((set, get) => ({
  issues: [],
  isLoading: false,
  error: null,
  currentProjectId: null,

  fetchIssues: async (projectId) => {
    const normalizedProjectId = projectId?.trim() || null;
    set({ isLoading: true, error: null, currentProjectId: normalizedProjectId });
    try {
      const api = getApiClient();
      const suffix = normalizedProjectId ? `?project_id=${encodeURIComponent(normalizedProjectId)}` : '';
      const issues = sortIssues(normalizeIssueList(await api.get(`/issues${suffix}`)));
      if (get().currentProjectId !== normalizedProjectId) {
        return;
      }
      set({ issues, isLoading: false });
    } catch (error) {
      if (get().currentProjectId !== normalizedProjectId) {
        return;
      }
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch issues',
      });
    }
  },

  createIssue: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const api = getApiClient();
      const issue = normalizeIssue(await api.post('/issues', input));
      if (!issue) {
        throw new Error('Invalid issue response');
      }
      set((state) => ({
        issues: upsertIssue(state.issues, issue),
        isLoading: false,
      }));
      return issue;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to create issue',
      });
      throw error;
    }
  },

  updateIssue: async (issueId, input) => {
    try {
      const api = getApiClient();
      const response = normalizeIssueMutationResponse(await api.patch(`/issues/${issueId}`, input));
      if (!response.issue) {
        throw new Error('Invalid issue response');
      }
      set((state) => ({
        issues: upsertIssue(state.issues, response.issue!),
      }));
      return response.issue;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to update issue',
      });
      throw error;
    }
  },

  moveIssue: async (issueId, status, position) => {
    return get().updateIssue(issueId, { status, position });
  },

  deleteIssue: async (issueId) => {
    try {
      const api = getApiClient();
      await api.delete(`/issues/${issueId}`);
      set((state) => ({
        issues: state.issues.filter((issue) => issue.id !== issueId),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete issue',
      });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));

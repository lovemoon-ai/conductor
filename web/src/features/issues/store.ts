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

const normalizeMemberRef = (value: unknown): { id: string; label?: string } | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = pickString(record.id);
  if (!id) {
    return null;
  }
  const label = pickString(record.label) ?? undefined;
  return label ? { id, label } : { id };
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

  // The API surfaces both camelCase and snake_case for these breadcrumb
  // fields; accept either so older clients/payloads don't drop the value.
  const aiBackendType = pickString(record.aiBackendType) ?? pickString(record.ai_backend_type);
  const aiSessionId = pickString(record.aiSessionId) ?? pickString(record.ai_session_id);

  // Owner / creator references drive the issue card's owner-badge avatar.
  // The API returns them as `ownerUserId` + `owner: {id,label}` (camelCase)
  // alongside the snake_case mirrors; accept either spelling so the card
  // can render the correct phone-suffix initials rather than "Unassigned".
  const ownerUserId = pickString(record.ownerUserId) ?? pickString(record.owner_user_id);
  const creatorUserId = pickString(record.creatorUserId) ?? pickString(record.creator_user_id);
  const owner = normalizeMemberRef(record.owner);
  const creator = normalizeMemberRef(record.creator);

  return {
    id,
    projectId,
    projectName: pickString(record.projectName) ?? pickString(record.project_name),
    daemonHost: pickString(record.daemonHost) ?? pickString(record.daemon_host),
    ownerUserId,
    creatorUserId,
    owner,
    creator,
    title,
    description: pickString(record.description),
    status: normalizeIssueStatus(record.status),
    priority: normalizeIssuePriority(record.priority),
    position,
    metadata: normalizeObject(record.metadata),
    aiBackendType,
    aiSessionId,
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

const projectScopeKey = (projectIds: string[]): string =>
  [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))]
    .sort()
    .join(',');

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
  /**
   * When the active project list view is a merged cross-daemon group, this
   * holds the full set of project ids the issue list is fetching for. Empty
   * when only `currentProjectId` is in use.
   */
  currentProjectIds: string[];
  fetchIssues: (projectId?: string | null) => Promise<void>;
  /**
   * Fetch issues across multiple projects in one call — used by the merged
   * cross-daemon view. Pass an empty list (or omit) to clear the merged
   * scope and fall back to fetching everything.
   */
  fetchIssuesForProjects: (projectIds: string[]) => Promise<void>;
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
  currentProjectIds: [],

  fetchIssues: async (projectId) => {
    const normalizedProjectId = projectId?.trim() || null;
    set({
      isLoading: true,
      error: null,
      currentProjectId: normalizedProjectId,
      currentProjectIds: [],
    });
    try {
      const api = getApiClient();
      const suffix = normalizedProjectId ? `?project_id=${encodeURIComponent(normalizedProjectId)}` : '';
      const issues = sortIssues(normalizeIssueList(await api.get(`/issues${suffix}`)));
      if (
        get().currentProjectId !== normalizedProjectId ||
        get().currentProjectIds.length !== 0
      ) {
        return;
      }
      set({ issues, isLoading: false });
    } catch (error) {
      if (
        get().currentProjectId !== normalizedProjectId ||
        get().currentProjectIds.length !== 0
      ) {
        return;
      }
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch issues',
      });
    }
  },

  fetchIssuesForProjects: async (projectIds) => {
    const normalized = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
    const requestScope = projectScopeKey(normalized);
    // Empty list ⇒ defer to fetchIssues with no project filter so callers can
    // unwind the merged scope without a second API call shape.
    if (normalized.length === 0) {
      await get().fetchIssues(null);
      return;
    }
    set({
      isLoading: true,
      error: null,
      currentProjectId: null,
      currentProjectIds: normalized,
    });
    try {
      const api = getApiClient();
      const suffix = `?project_ids=${encodeURIComponent(normalized.join(','))}`;
      const issues = sortIssues(normalizeIssueList(await api.get(`/issues${suffix}`)));
      const currentScope = projectScopeKey(get().currentProjectIds);
      if (currentScope !== requestScope) {
        return;
      }
      set({ issues, isLoading: false });
    } catch (error) {
      const currentScope = projectScopeKey(get().currentProjectIds);
      if (currentScope !== requestScope) {
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

/**
 * Merge an `issue.created` realtime payload into the local list. RFC 0025 §5.3
 * — the server broadcasts every fresh create over the same per-user app
 * WebSocket; we dedupe by `id` so the user who issued the POST does not see
 * the same issue twice when the WS event races the HTTP response.
 *
 * Scope filter: skip merging when the user is viewing a different project
 * (single-project mode with `currentProjectId` set to a different project, or
 * a merged `currentProjectIds` scope that does not include the new issue's
 * project). The all-projects view (`currentProjectId === null` and
 * `currentProjectIds.length === 0`) accepts every event.
 */
export const applyIssueCreatedEvent = (raw: unknown): void => {
  const candidate =
    raw && typeof raw === 'object' && 'issue' in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).issue
      : raw;
  const issue = normalizeIssue(candidate);
  if (!issue) return;
  const state = useIssuesStore.getState();
  const inSingleScope = state.currentProjectId !== null;
  const inMergedScope = state.currentProjectIds.length > 0;
  if (inSingleScope && state.currentProjectId !== issue.projectId) return;
  if (inMergedScope && !state.currentProjectIds.includes(issue.projectId)) return;
  if (state.issues.some((existing) => existing.id === issue.id)) return;
  useIssuesStore.setState({
    issues: sortIssues([issue, ...state.issues]),
  });
};

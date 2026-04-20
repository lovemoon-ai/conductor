import { create } from 'zustand';
import type { Project, CreateProjectInput, UpdateProjectInput } from '@/shared/types';
import { getApiClient } from '@/shared/api/client';

const SELECTED_PROJECT_STORAGE_KEY = 'conductor-selected-project-id';
const HIDDEN_PROJECTS_STORAGE_KEY = 'conductor-hidden-project-ids';
const SHOW_HIDDEN_PROJECTS_STORAGE_KEY = 'conductor-show-hidden-projects';

const readStoredSelectedProjectId = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
};

const writeStoredSelectedProjectId = (projectId: string | null) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (projectId) {
      window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
    } else {
      window.localStorage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures; selection still works for the current session.
  }
};

const readStoredHiddenProjectIds = (): string[] => {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(HIDDEN_PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const ids = parsed
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return [...new Set(ids)];
  } catch {
    return [];
  }
};

const writeStoredHiddenProjectIds = (projectIds: string[]) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (projectIds.length === 0) {
      window.localStorage.removeItem(HIDDEN_PROJECTS_STORAGE_KEY);
    } else {
      window.localStorage.setItem(HIDDEN_PROJECTS_STORAGE_KEY, JSON.stringify(projectIds));
    }
  } catch {
    // Ignore storage failures; hidden project state still works for the current session.
  }
};

const readStoredShowHiddenProjects = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    return window.localStorage.getItem(SHOW_HIDDEN_PROJECTS_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const writeStoredShowHiddenProjects = (value: boolean) => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (value) {
      window.localStorage.setItem(SHOW_HIDDEN_PROJECTS_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(SHOW_HIDDEN_PROJECTS_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures; visibility state still works for the current session.
  }
};

const pickString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  return value;
};

const normalizeTaskStatusCounts = (value: unknown): Record<string, number> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (typeof val === 'number' && val > 0) {
      result[key] = val;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
};

const pickInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

// Accept both camelCase and snake_case fields from the projects API so a
// future server-side rename cannot silently leave UI state undefined.
// See claw/lessons/arch_project_api_snake_case_regression_20260409.md.
export const normalizeProject = (raw: unknown): Project | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record.id);
  const name = pickString(record.name);
  if (!id || !name) return null;

  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : null;

  return {
    id,
    name,
    daemonHost: pickString(record.daemonHost) ?? pickString(record.daemon_host),
    workspacePath: pickString(record.workspacePath) ?? pickString(record.workspace_path),
    repoRoot: pickString(record.repoRoot) ?? pickString(record.repo_root),
    worktreeBranch: pickString(record.worktreeBranch) ?? pickString(record.worktree_branch),
    lastCommit: pickString(record.lastCommit) ?? pickString(record.last_commit),
    fileCount: pickInt(record.fileCount) ?? pickInt(record.file_count),
    sortOrder: pickInt(record.sortOrder) ?? pickInt(record.sort_order) ?? null,
    isDefault:
      typeof record.isDefault === 'boolean'
        ? record.isDefault
        : typeof record.is_default === 'boolean'
          ? record.is_default
          : false,
    metadata,
    taskStatusCounts: normalizeTaskStatusCounts(record.taskStatusCounts ?? record.task_status_counts),
    createdAt:
      pickString(record.createdAt) ?? pickString(record.created_at) ?? undefined,
    updatedAt:
      pickString(record.updatedAt) ?? pickString(record.updated_at) ?? undefined,
  };
};

const normalizeProjectList = (raw: unknown): Project[] => {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => normalizeProject(entry))
    .filter((project): project is Project => project !== null);
};

interface ProjectsState {
  projects: Project[];
  isLoading: boolean;
  error: string | null;
  selectedProjectId: string | null;
  hiddenProjectIds: string[];
  showHiddenProjects: boolean;

  // Actions
  fetchProjects: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (projectId: string, input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  setSelectedProjectId: (projectId: string | null) => void;
  hideProject: (projectId: string) => void;
  unhideProject: (projectId: string) => void;
  toggleShowHiddenProjects: () => void;
  clearError: () => void;
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],
  isLoading: false,
  error: null,
  selectedProjectId: readStoredSelectedProjectId(),
  hiddenProjectIds: readStoredHiddenProjectIds(),
  showHiddenProjects: readStoredShowHiddenProjects(),

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const api = getApiClient();
      const raw = await api.get<unknown>('/projects');
      const projects = normalizeProjectList(raw);
      const currentSelectedProjectId = get().selectedProjectId;
      const projectIds = new Set(projects.map((project) => project.id));
      const hiddenProjectIds = get().hiddenProjectIds.filter((projectId) => projectIds.has(projectId));
      const hiddenProjectIdSet = new Set(hiddenProjectIds);
      const selectedProjectId = currentSelectedProjectId
        && projectIds.has(currentSelectedProjectId)
        && (get().showHiddenProjects || !hiddenProjectIdSet.has(currentSelectedProjectId))
        ? currentSelectedProjectId
        : null;
      if (selectedProjectId !== currentSelectedProjectId) {
        writeStoredSelectedProjectId(selectedProjectId);
      }
      if (hiddenProjectIds.length !== get().hiddenProjectIds.length) {
        writeStoredHiddenProjectIds(hiddenProjectIds);
      }
      set({ projects, selectedProjectId, hiddenProjectIds, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch projects',
      });
    }
  },

  createProject: async (input) => {
    set({ isLoading: true, error: null });
    try {
      const api = getApiClient();
      const raw = await api.post<unknown>('/projects', input);
      const project = normalizeProject(raw);
      if (!project) {
        throw new Error('Invalid project response');
      }
      set((state) => ({
        projects: [...state.projects, project],
        isLoading: false,
      }));
      return project;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to create project',
      });
      throw error;
    }
  },

  updateProject: async (projectId, input) => {
    try {
      const api = getApiClient();
      const raw = await api.patch<unknown>(
        `/projects?projectId=${encodeURIComponent(projectId)}`,
        input,
      );
      const project = normalizeProject(raw);
      if (!project) {
        throw new Error('Invalid project response');
      }
      set((state) => ({
        projects: state.projects.map((p) => (p.id === projectId ? project : p)),
      }));
      return project;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to update project',
      });
      throw error;
    }
  },

  deleteProject: async (projectId) => {
    try {
      const api = getApiClient();
      await api.delete(`/projects?projectId=${encodeURIComponent(projectId)}`);
      const shouldClearSelectedProject = get().selectedProjectId === projectId;
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
        selectedProjectId: shouldClearSelectedProject ? null : state.selectedProjectId,
      }));
      if (shouldClearSelectedProject) {
        writeStoredSelectedProjectId(null);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete project',
      });
      throw error;
    }
  },

  reorderProjects: async (projectIds) => {
    const previousProjects = get().projects;
    const projectMap = new Map(previousProjects.map((p) => [p.id, p]));
    const reordered = projectIds
      .map((id) => projectMap.get(id))
      .filter((p): p is Project => p !== undefined);
    const reorderedIds = new Set(projectIds);
    const remaining = previousProjects.filter((p) => !reorderedIds.has(p.id));
    set({ projects: [...reordered, ...remaining] });

    try {
      const api = getApiClient();
      await api.post('/projects/reorder', { projectIds });
    } catch (error) {
      set({ projects: previousProjects });
      set({
        error: error instanceof Error ? error.message : 'Failed to reorder projects',
      });
    }
  },

  setSelectedProjectId: (projectId) => {
    const selectedProjectId = projectId?.trim() || null;
    writeStoredSelectedProjectId(selectedProjectId);
    set({ selectedProjectId });
  },

  hideProject: (projectId) => {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      return;
    }
    const hiddenProjectIds = get().hiddenProjectIds.includes(normalizedProjectId)
      ? get().hiddenProjectIds
      : [...get().hiddenProjectIds, normalizedProjectId];
    writeStoredHiddenProjectIds(hiddenProjectIds);
    writeStoredShowHiddenProjects(false);
    const shouldClearSelectedProject = get().selectedProjectId === normalizedProjectId;
    if (shouldClearSelectedProject) {
      writeStoredSelectedProjectId(null);
    }
    set((state) => ({
      hiddenProjectIds,
      showHiddenProjects: false,
      selectedProjectId: shouldClearSelectedProject ? null : state.selectedProjectId,
    }));
  },

  unhideProject: (projectId) => {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      return;
    }
    const hiddenProjectIds = get().hiddenProjectIds.filter((id) => id !== normalizedProjectId);
    writeStoredHiddenProjectIds(hiddenProjectIds);
    set({ hiddenProjectIds });
  },

  toggleShowHiddenProjects: () => {
    const nextShowHiddenProjects = !get().showHiddenProjects;
    writeStoredShowHiddenProjects(nextShowHiddenProjects);
    const hiddenProjectIdSet = new Set(get().hiddenProjectIds);
    const selectedProjectId = get().selectedProjectId;
    const shouldClearSelectedProject =
      !nextShowHiddenProjects
      && selectedProjectId !== null
      && hiddenProjectIdSet.has(selectedProjectId);
    if (shouldClearSelectedProject) {
      writeStoredSelectedProjectId(null);
    }
    set((state) => ({
      showHiddenProjects: nextShowHiddenProjects,
      selectedProjectId: shouldClearSelectedProject ? null : state.selectedProjectId,
    }));
  },

  clearError: () => set({ error: null }),
}));

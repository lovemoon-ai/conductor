import { create } from 'zustand';
import type { Project, CreateProjectInput, UpdateProjectInput } from '@/shared/types';
import { getApiClient } from '@/shared/api/client';

const SELECTED_PROJECT_STORAGE_KEY = 'conductor-selected-project-id';

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

const pickString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  return value;
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
    isDefault:
      typeof record.isDefault === 'boolean'
        ? record.isDefault
        : typeof record.is_default === 'boolean'
          ? record.is_default
          : false,
    metadata,
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

  // Actions
  fetchProjects: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (projectId: string, input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  setSelectedProjectId: (projectId: string | null) => void;
  clearError: () => void;
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],
  isLoading: false,
  error: null,
  selectedProjectId: readStoredSelectedProjectId(),

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const api = getApiClient();
      const raw = await api.get<unknown>('/projects');
      const projects = normalizeProjectList(raw);
      const currentSelectedProjectId = get().selectedProjectId;
      const selectedProjectId = currentSelectedProjectId && projects.some((project) => project.id === currentSelectedProjectId)
        ? currentSelectedProjectId
        : null;
      if (selectedProjectId !== currentSelectedProjectId) {
        writeStoredSelectedProjectId(selectedProjectId);
      }
      set({ projects, selectedProjectId, isLoading: false });
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

  setSelectedProjectId: (projectId) => {
    const selectedProjectId = projectId?.trim() || null;
    writeStoredSelectedProjectId(selectedProjectId);
    set({ selectedProjectId });
  },

  clearError: () => set({ error: null }),
}));

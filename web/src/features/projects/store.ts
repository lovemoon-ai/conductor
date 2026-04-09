import { create } from 'zustand';
import type { Project, CreateProjectInput, UpdateProjectInput } from '@/shared/types';
import { getApiClient } from '@/shared/api/client';

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

  // Actions
  fetchProjects: () => Promise<void>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
  updateProject: (projectId: string, input: UpdateProjectInput) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  clearError: () => void;
}

export const useProjectsStore = create<ProjectsState>()((set) => ({
  projects: [],
  isLoading: false,
  error: null,

  fetchProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const api = getApiClient();
      const raw = await api.get<unknown>('/projects');
      set({ projects: normalizeProjectList(raw), isLoading: false });
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
      set((state) => ({
        projects: state.projects.filter((p) => p.id !== projectId),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to delete project',
      });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));

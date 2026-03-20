import { create } from 'zustand';
import type { Project, CreateProjectInput, UpdateProjectInput } from '../types';
import { getApiClient } from '../api/client';

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
      const projects = await api.get<Project[]>('/projects');
      set({ projects, isLoading: false });
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
      const project = await api.post<Project>('/projects', input);
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
      const project = await api.patch<Project>(`/projects?projectId=${encodeURIComponent(projectId)}`, input);
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

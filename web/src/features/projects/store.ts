import { create } from 'zustand';
import type {
  CollaborationMember,
  Project,
  ProjectCollaboration,
  ProjectGroup,
  CreateProjectInput,
  UpdateProjectInput,
} from '@/shared/types';
import { getApiClient } from '@/shared/api/client';
import { getStoredJwtToken } from '@/lib/auth/token-storage';
import { computeProjectGroups } from './utils/project-groups';

const SELECTED_PROJECT_STORAGE_KEY = 'conductor-selected-project-id';
// Legacy key kept only for one-time migration to the server-side hidden state.
// Once the server confirms each entry, the key is removed from localStorage.
const HIDDEN_PROJECTS_STORAGE_KEY = 'conductor-hidden-project-ids';
const SHOW_HIDDEN_PROJECTS_STORAGE_KEY = 'conductor-show-hidden-projects';

const collectHiddenProjectIds = (projects: Project[]): string[] =>
  projects.filter((project) => project.hidden === true).map((project) => project.id);

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

const clearStoredHiddenProjectIds = () => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.removeItem(HIDDEN_PROJECTS_STORAGE_KEY);
  } catch {
    // Ignore storage failures; the migration will retry on next launch.
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

const normalizeCollaborationMember = (raw: unknown): CollaborationMember | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record.id);
  const userId = pickString(record.userId) ?? pickString(record.user_id);
  const projectId = pickString(record.projectId) ?? pickString(record.project_id);
  const label = pickString(record.label)
    ?? (record.user && typeof record.user === 'object'
      ? pickString((record.user as Record<string, unknown>).label)
      : null)
    ?? userId;
  if (!id || !userId || !projectId || !label) return null;

  const user = record.user && typeof record.user === 'object' && !Array.isArray(record.user)
    ? record.user as Record<string, unknown>
    : null;
  const project = record.project && typeof record.project === 'object' && !Array.isArray(record.project)
    ? record.project as Record<string, unknown>
    : null;
  const projectName = pickString(record.projectName)
    ?? pickString(record.project_name)
    ?? (project ? pickString(project.name) : null)
    ?? undefined;

  return {
    id,
    userId,
    projectId,
    projectName,
    label,
    joinedAt: pickString(record.joinedAt) ?? pickString(record.joined_at) ?? undefined,
    user: user
      ? {
          id: pickString(user.id) ?? userId,
          label: pickString(user.label) ?? pickString(user.email) ?? pickString(user.phone) ?? label,
        }
      : undefined,
    project: project
      ? {
          id: pickString(project.id) ?? projectId,
          name: pickString(project.name) ?? projectName ?? projectId,
        }
      : undefined,
  };
};

const normalizeCollaboration = (raw: unknown): ProjectCollaboration | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const id = pickString(record.id);
  const inviteToken = pickString(record.inviteToken) ?? pickString(record.invite_token);
  if (!id || !inviteToken) return null;
  const members = Array.isArray(record.members)
    ? record.members
        .map((entry) => normalizeCollaborationMember(entry))
        .filter((member): member is CollaborationMember => member !== null)
    : [];
  return {
    id,
    inviteToken,
    inviteUrl: pickString(record.inviteUrl) ?? pickString(record.invite_url) ?? undefined,
    memberCount: pickInt(record.memberCount) ?? pickInt(record.member_count) ?? members.length,
    maxMembers: pickInt(record.maxMembers) ?? pickInt(record.max_members) ?? 5,
    members,
    createdAt: pickString(record.createdAt) ?? pickString(record.created_at) ?? undefined,
  };
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

  const hiddenFlag =
    typeof record.hidden === 'boolean'
      ? record.hidden
      : typeof record.is_hidden === 'boolean'
        ? record.is_hidden
        : null;
  const hiddenAtValue =
    pickString(record.hiddenAt) ?? pickString(record.hidden_at) ?? null;
  const hidden = hiddenFlag ?? Boolean(hiddenAtValue);

  return {
    id,
    name,
    collaborationId: pickString(record.collaborationId) ?? pickString(record.collaboration_id),
    collaboration: normalizeCollaboration(record.collaboration),
    daemonHost: pickString(record.daemonHost) ?? pickString(record.daemon_host),
    workspacePath: pickString(record.workspacePath) ?? pickString(record.workspace_path),
    repoRoot: pickString(record.repoRoot) ?? pickString(record.repo_root),
    worktreeBranch: pickString(record.worktreeBranch) ?? pickString(record.worktree_branch),
    lastCommit: pickString(record.lastCommit) ?? pickString(record.last_commit),
    gitRemoteUrl: pickString(record.gitRemoteUrl) ?? pickString(record.git_remote_url),
    fileCount: pickInt(record.fileCount) ?? pickInt(record.file_count),
    sortOrder: pickInt(record.sortOrder) ?? pickInt(record.sort_order) ?? null,
    hidden,
    mergeOptOut:
      typeof record.mergeOptOut === 'boolean'
        ? record.mergeOptOut
        : typeof record.merge_opt_out === 'boolean'
          ? record.merge_opt_out
          : false,
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

let fetchProjectsRequestSequence = 0;

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
  startProjectCollaboration: (projectId: string) => Promise<ProjectCollaboration>;
  leaveCollaboration: (collaborationId: string) => Promise<void>;
  reorderProjects: (projectIds: string[]) => Promise<void>;
  setSelectedProjectId: (projectId: string | null) => void;
  hideProject: (projectId: string) => void;
  unhideProject: (projectId: string) => void;
  /**
   * Bulk-apply hide/unhide to every member of a merged project group. Used by
   * the cross-daemon merged card whose primary action affects all members.
   * Fire-and-forget — relies on the per-project optimistic flow with its own
   * background server confirmation.
   */
  hideProjectGroup: (projectIds: string[]) => void;
  unhideProjectGroup: (projectIds: string[]) => void;
  /**
   * Bulk-delete every member of a merged project group. Awaitable: callers
   * (e.g. ProjectItem confirm dialog) need to know when every member is gone
   * so the toast / spinner can sequence correctly.
   */
  deleteProjectGroup: (projectIds: string[]) => Promise<void>;
  /** Toggle a single project's mergeOptOut flag (split / re-merge). */
  setProjectMergeOptOut: (projectId: string, value: boolean) => Promise<Project>;
  /** Re-validate a project against its daemon to refresh git fields. */
  refreshProject: (projectId: string) => Promise<Project>;
  toggleShowHiddenProjects: () => void;
  resetState: () => void;
  clearError: () => void;
}

// Tracks an in-flight one-time migration of legacy localStorage hidden ids so
// that simultaneous fetches do not double-fire PATCH requests.
let legacyHiddenMigrationPromise: Promise<void> | null = null;

const migrateLegacyHiddenProjectIds = async (projects: Project[]): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }
  const localIds = readStoredHiddenProjectIds();
  if (localIds.length === 0) {
    return false;
  }

  const projectsById = new Map(projects.map((project) => [project.id, project] as const));
  const toHide = localIds.filter((id) => {
    const project = projectsById.get(id);
    if (!project) return false;
    if (project.isDefault) return false;
    return project.hidden !== true;
  });

  let allOk = true;
  if (toHide.length > 0) {
    const api = getApiClient();
    const results = await Promise.allSettled(
      toHide.map((id) =>
        api.patch<unknown>(
          `/projects?projectId=${encodeURIComponent(id)}`,
          { hidden: true },
        ),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        allOk = false;
        // Keep the legacy key around so that the next launch can retry.
      }
    }
  }

  if (allOk) {
    clearStoredHiddenProjectIds();
    return toHide.length > 0;
  }
  return false;
};

const triggerLegacyHiddenMigration = (projects: Project[], applyHidden: (ids: string[]) => void) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (legacyHiddenMigrationPromise) {
    return;
  }
  if (readStoredHiddenProjectIds().length === 0) {
    return;
  }
  legacyHiddenMigrationPromise = (async () => {
    try {
      const migrated = await migrateLegacyHiddenProjectIds(projects);
      if (migrated) {
        applyHidden(readStoredHiddenProjectIds());
      }
    } catch {
      // Swallow — failures keep the legacy key for next-launch retry.
    } finally {
      legacyHiddenMigrationPromise = null;
    }
  })();
};

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],
  isLoading: false,
  error: null,
  selectedProjectId: readStoredSelectedProjectId(),
  hiddenProjectIds: [],
  showHiddenProjects: readStoredShowHiddenProjects(),

  fetchProjects: async () => {
    const requestId = ++fetchProjectsRequestSequence;
    const requestJwtToken = getStoredJwtToken();
    set({ isLoading: true, error: null });
    try {
      const api = getApiClient();
      const raw = await api.get<unknown>('/projects');
      const projects = normalizeProjectList(raw);
      const currentJwtToken = getStoredJwtToken();
      if (requestId !== fetchProjectsRequestSequence || requestJwtToken !== currentJwtToken) {
        if (requestId === fetchProjectsRequestSequence && requestJwtToken !== currentJwtToken) {
          set({ isLoading: false });
        }
        return;
      }
      const currentSelectedProjectId = get().selectedProjectId;
      const projectIds = new Set(projects.map((project) => project.id));
      const hiddenProjectIds = collectHiddenProjectIds(projects);
      const hiddenProjectIdSet = new Set(hiddenProjectIds);
      const selectedProjectId = currentSelectedProjectId
        && projectIds.has(currentSelectedProjectId)
        && (get().showHiddenProjects || !hiddenProjectIdSet.has(currentSelectedProjectId))
        ? currentSelectedProjectId
        : null;
      if (selectedProjectId !== currentSelectedProjectId) {
        writeStoredSelectedProjectId(selectedProjectId);
      }
      set({ projects, selectedProjectId, hiddenProjectIds, isLoading: false });

      // Kick off a one-time migration of any legacy localStorage entries; runs
      // in the background and re-fetches projects on success so the UI picks up
      // the server-side hidden state.
      triggerLegacyHiddenMigration(projects, () => {
        void get().fetchProjects();
      });
    } catch (error) {
      const currentJwtToken = getStoredJwtToken();
      if (requestId !== fetchProjectsRequestSequence || requestJwtToken !== currentJwtToken) {
        if (requestId === fetchProjectsRequestSequence && requestJwtToken !== currentJwtToken) {
          set({ isLoading: false });
        }
        return;
      }
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

  startProjectCollaboration: async (projectId) => {
    try {
      const api = getApiClient();
      const raw = await api.post<unknown>(`/projects/${encodeURIComponent(projectId)}/collaboration`);
      const record = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : {};
      const collaboration = normalizeCollaboration(record.collaboration);
      if (!collaboration) {
        throw new Error('Invalid collaboration response');
      }
      set((state) => ({
        projects: state.projects.map((project) => (
          project.id === projectId
            ? { ...project, collaborationId: collaboration.id, collaboration }
            : project
        )),
      }));
      return collaboration;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to start collaboration',
      });
      throw error;
    }
  },

  leaveCollaboration: async (collaborationId) => {
    try {
      const api = getApiClient();
      await api.delete(`/collaboration/${encodeURIComponent(collaborationId)}/members/me`);
      set((state) => ({
        projects: state.projects.map((project) => (
          project.collaboration?.id === collaborationId || project.collaborationId === collaborationId
            ? { ...project, collaborationId: null, collaboration: null }
            : project
        )),
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to leave collaboration',
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
    const previousProjects = get().projects;
    const previousSelectedProjectId = get().selectedProjectId;
    const previousShowHiddenProjects = get().showHiddenProjects;
    const targetProject = previousProjects.find((p) => p.id === normalizedProjectId);
    if (!targetProject) {
      return;
    }
    if (targetProject.isDefault) {
      // Default project cannot be hidden; mirror the server-side guard.
      return;
    }

    // Optimistic update.
    const nextProjects = previousProjects.map((project) =>
      project.id === normalizedProjectId ? { ...project, hidden: true } : project,
    );
    const hiddenProjectIds = collectHiddenProjectIds(nextProjects);
    const shouldClearSelectedProject = previousSelectedProjectId === normalizedProjectId;
    if (shouldClearSelectedProject) {
      writeStoredSelectedProjectId(null);
    }
    writeStoredShowHiddenProjects(false);
    set((state) => ({
      projects: nextProjects,
      hiddenProjectIds,
      showHiddenProjects: false,
      selectedProjectId: shouldClearSelectedProject ? null : state.selectedProjectId,
    }));

    if (targetProject.hidden === true) {
      // Already hidden on the server; nothing else to do.
      return;
    }

    void (async () => {
      try {
        const api = getApiClient();
        const raw = await api.patch<unknown>(
          `/projects?projectId=${encodeURIComponent(normalizedProjectId)}`,
          { hidden: true },
        );
        const updated = normalizeProject(raw);
        if (!updated) return;
        set((state) => {
          const merged = state.projects.map((p) => (p.id === normalizedProjectId ? updated : p));
          return {
            projects: merged,
            hiddenProjectIds: collectHiddenProjectIds(merged),
          };
        });
      } catch (error) {
        // Roll back optimistic update on failure.
        if (shouldClearSelectedProject && previousSelectedProjectId) {
          writeStoredSelectedProjectId(previousSelectedProjectId);
        }
        writeStoredShowHiddenProjects(previousShowHiddenProjects);
        set({
          projects: previousProjects,
          hiddenProjectIds: collectHiddenProjectIds(previousProjects),
          showHiddenProjects: previousShowHiddenProjects,
          selectedProjectId: previousSelectedProjectId,
          error: error instanceof Error ? error.message : 'Failed to hide project',
        });
      }
    })();
  },

  unhideProject: (projectId) => {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      return;
    }
    const previousProjects = get().projects;
    const targetProject = previousProjects.find((p) => p.id === normalizedProjectId);
    if (!targetProject) {
      return;
    }

    // Optimistic update.
    const nextProjects = previousProjects.map((project) =>
      project.id === normalizedProjectId ? { ...project, hidden: false } : project,
    );
    const hiddenProjectIds = collectHiddenProjectIds(nextProjects);
    set({
      projects: nextProjects,
      hiddenProjectIds,
    });

    if (targetProject.hidden !== true) {
      // Was not actually hidden on the server; skip the round-trip.
      return;
    }

    void (async () => {
      try {
        const api = getApiClient();
        const raw = await api.patch<unknown>(
          `/projects?projectId=${encodeURIComponent(normalizedProjectId)}`,
          { hidden: false },
        );
        const updated = normalizeProject(raw);
        if (!updated) return;
        set((state) => {
          const merged = state.projects.map((p) => (p.id === normalizedProjectId ? updated : p));
          return {
            projects: merged,
            hiddenProjectIds: collectHiddenProjectIds(merged),
          };
        });
      } catch (error) {
        set({
          projects: previousProjects,
          hiddenProjectIds: collectHiddenProjectIds(previousProjects),
          error: error instanceof Error ? error.message : 'Failed to restore project',
        });
      }
    })();
  },

  hideProjectGroup: (projectIds) => {
    const targets = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
    for (const id of targets) {
      // Reuse the optimistic single-project flow per member; failures roll back
      // independently (acceptable since members are independent DB rows).
      get().hideProject(id);
    }
  },

  unhideProjectGroup: (projectIds) => {
    const targets = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
    for (const id of targets) {
      get().unhideProject(id);
    }
  },

  deleteProjectGroup: async (projectIds) => {
    const targets = [...new Set(projectIds.map((id) => id.trim()).filter(Boolean))];
    // Sequential: each daemon may need to clean up worktrees before its
    // project row can be deleted; running them in parallel would multiply
    // failure modes when daemons share state.
    for (const id of targets) {
      await get().deleteProject(id);
    }
  },

  setProjectMergeOptOut: async (projectId, value) => {
    try {
      const api = getApiClient();
      const raw = await api.patch<unknown>(
        `/projects?projectId=${encodeURIComponent(projectId)}`,
        { mergeOptOut: value },
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
        error: error instanceof Error ? error.message : 'Failed to update merge state',
      });
      throw error;
    }
  },

  refreshProject: async (projectId) => {
    try {
      const api = getApiClient();
      const raw = await api.patch<unknown>(
        `/projects?projectId=${encodeURIComponent(projectId)}`,
        { refresh: true },
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
        error: error instanceof Error ? error.message : 'Failed to refresh project',
      });
      throw error;
    }
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

  resetState: () => {
    fetchProjectsRequestSequence += 1;
    legacyHiddenMigrationPromise = null;
    writeStoredSelectedProjectId(null);
    set({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      hiddenProjectIds: [],
    });
  },

  clearError: () => set({ error: null }),
}));

/**
 * Pure helper kept outside of zustand so tests and non-React callers can
 * derive groups without instantiating a store.
 *
 * Result is memoized against the input array's identity so consecutive calls
 * with the same `projects` reference return the same `ProjectGroup[]`. This
 * matters because the function is fed straight into a zustand selector — if
 * we returned a fresh array every call, every store update (including
 * unrelated ones like `setSelectedProjectId`) would force-rerender every
 * subscriber.
 */
const projectGroupsCache = new WeakMap<Project[], ProjectGroup[]>();
export const selectProjectGroups = (projects: Project[]): ProjectGroup[] => {
  const cached = projectGroupsCache.get(projects);
  if (cached) return cached;
  const computed = computeProjectGroups(projects);
  projectGroupsCache.set(projects, computed);
  return computed;
};

/**
 * Resolve which group a given project belongs to. Returns the matching group
 * or `null` if the project is not in the supplied list.
 */
export const findProjectGroup = (
  groups: ProjectGroup[],
  projectId: string | null | undefined,
): ProjectGroup | null => {
  if (!projectId) return null;
  for (const group of groups) {
    if (group.members.some((member) => member.id === projectId)) {
      return group;
    }
  }
  return null;
};

/**
 * Hook: derive the merged-project groups from the current store snapshot.
 * Intentionally light — group computation is O(n^2) over a list of typically
 * < 100 projects, which is comfortably fast on every render.
 */
export const useProjectGroups = (): ProjectGroup[] =>
  useProjectsStore((state) => selectProjectGroups(state.projects));

/**
 * Hook: return the project ids for the currently selected group, in member
 * order. When nothing is selected, returns an empty array. UI consumers use
 * this to call `/api/issues?project_ids=…` for cross-daemon merged views.
 */
export const useSelectedProjectGroupIds = (): string[] => {
  const groups = useProjectGroups();
  const selectedProjectId = useProjectsStore((state) => state.selectedProjectId);
  const group = findProjectGroup(groups, selectedProjectId);
  return group ? group.members.map((member) => member.id) : [];
};

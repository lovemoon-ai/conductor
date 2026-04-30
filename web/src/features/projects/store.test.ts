import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JWT_STORAGE_KEY } from '@/lib/auth/token-storage';

const mockGet = vi.fn();
const mockPost = vi.fn();
const mockPatch = vi.fn();
const mockDelete = vi.fn();

vi.mock('@/shared/api/client', () => ({
  getApiClient: () => ({
    get: mockGet,
    post: mockPost,
    patch: mockPatch,
    delete: mockDelete,
  }),
}));

import { normalizeProject, useProjectsStore } from './store';

describe('normalizeProject', () => {
  it('reads camelCase fields from a server response', () => {
    const project = normalizeProject({
      id: 'proj-1',
      name: 'Alpha',
      daemonHost: 'daemon-a',
      workspacePath: '/repo/alpha',
      repoRoot: '/repo',
      worktreeBranch: 'main',
      lastCommit: 'abc123',
      fileCount: 42,
      isDefault: false,
      metadata: { localPaths: { 'daemon-a': '/repo/alpha' } },
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:01:00.000Z',
    });
    expect(project).toMatchObject({
      id: 'proj-1',
      name: 'Alpha',
      daemonHost: 'daemon-a',
      workspacePath: '/repo/alpha',
      repoRoot: '/repo',
      worktreeBranch: 'main',
      lastCommit: 'abc123',
      fileCount: 42,
      isDefault: false,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:01:00.000Z',
    });
  });

  it('falls back to snake_case fields when camelCase is missing', () => {
    const project = normalizeProject({
      id: 'proj-2',
      name: 'Beta',
      daemon_host: 'daemon-b',
      workspace_path: '/repo/beta',
      repo_root: '/repo',
      worktree_branch: 'dev',
      last_commit: 'def456',
      file_count: 7,
      is_default: true,
      created_at: '2026-04-09T00:00:00.000Z',
      updated_at: '2026-04-09T00:02:00.000Z',
    });
    expect(project).toMatchObject({
      id: 'proj-2',
      name: 'Beta',
      daemonHost: 'daemon-b',
      workspacePath: '/repo/beta',
      repoRoot: '/repo',
      worktreeBranch: 'dev',
      lastCommit: 'def456',
      fileCount: 7,
      isDefault: true,
      createdAt: '2026-04-09T00:00:00.000Z',
      updatedAt: '2026-04-09T00:02:00.000Z',
    });
  });

  it('prefers camelCase when both casings are present', () => {
    const project = normalizeProject({
      id: 'proj-3',
      name: 'Gamma',
      daemonHost: 'daemon-x',
      daemon_host: 'daemon-y',
      isDefault: true,
      is_default: false,
    });
    expect(project?.daemonHost).toBe('daemon-x');
    expect(project?.isDefault).toBe(true);
  });

  it('returns null for invalid input', () => {
    expect(normalizeProject(null)).toBeNull();
    expect(normalizeProject({})).toBeNull();
    expect(normalizeProject({ id: 'only-id' })).toBeNull();
    expect(normalizeProject({ name: 'only-name' })).toBeNull();
  });

  it('defaults isDefault to false when missing', () => {
    const project = normalizeProject({ id: 'p', name: 'p' });
    expect(project?.isDefault).toBe(false);
  });
});

describe('useProjectsStore hidden project state', () => {
  const flushAsync = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const seedProject = (overrides: Partial<{
    id: string;
    name: string;
    hidden: boolean;
    isDefault: boolean;
  }> = {}) => ({
    id: overrides.id ?? 'project-1',
    name: overrides.name ?? 'Project One',
    hidden: overrides.hidden ?? false,
    isDefault: overrides.isDefault ?? false,
    daemonHost: null,
    workspacePath: null,
    repoRoot: null,
    worktreeBranch: null,
    lastCommit: null,
    fileCount: null,
    sortOrder: null,
    metadata: null,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useProjectsStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
    });
  });

  it('hides a project optimistically, calls the API, and clears it when selected', async () => {
    const project = seedProject({ id: 'project-1' });
    useProjectsStore.setState({
      projects: [project],
      selectedProjectId: 'project-1',
      showHiddenProjects: true,
    });

    mockPatch.mockResolvedValueOnce({ ...project, hidden: true });

    useProjectsStore.getState().hideProject('project-1');

    // Optimistic update is applied synchronously.
    expect(useProjectsStore.getState().hiddenProjectIds).toEqual(['project-1']);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    expect(useProjectsStore.getState().showHiddenProjects).toBe(false);
    expect(window.localStorage.getItem('conductor-selected-project-id')).toBeNull();

    await flushAsync();

    expect(mockPatch).toHaveBeenCalledWith(
      '/projects?projectId=project-1',
      { hidden: true },
    );
    expect(useProjectsStore.getState().projects[0].hidden).toBe(true);
  });

  it('refuses to hide the default project', async () => {
    const project = seedProject({ id: 'default-project', isDefault: true });
    useProjectsStore.setState({ projects: [project] });

    useProjectsStore.getState().hideProject('default-project');
    await flushAsync();

    expect(useProjectsStore.getState().hiddenProjectIds).toEqual([]);
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic update when the hide API call fails', async () => {
    const project = seedProject({ id: 'project-1' });
    useProjectsStore.setState({
      projects: [project],
      selectedProjectId: 'project-1',
      showHiddenProjects: true,
    });

    mockPatch.mockRejectedValueOnce(new Error('Network down'));

    useProjectsStore.getState().hideProject('project-1');
    await flushAsync();

    expect(useProjectsStore.getState().projects[0].hidden).toBe(false);
    expect(useProjectsStore.getState().hiddenProjectIds).toEqual([]);
    expect(useProjectsStore.getState().showHiddenProjects).toBe(true);
    expect(useProjectsStore.getState().selectedProjectId).toBe('project-1');
    expect(useProjectsStore.getState().error).toBe('Network down');
  });

  it('clears a selected hidden project when hiding hidden cards again', () => {
    const project = seedProject({ id: 'project-1', hidden: true });
    useProjectsStore.setState({
      projects: [project],
      selectedProjectId: 'project-1',
      hiddenProjectIds: ['project-1'],
      showHiddenProjects: true,
    });

    useProjectsStore.getState().toggleShowHiddenProjects();

    expect(useProjectsStore.getState().showHiddenProjects).toBe(false);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
  });

  it('restores a hidden project optimistically and persists via the API', async () => {
    const project = seedProject({ id: 'project-1', hidden: true });
    useProjectsStore.setState({
      projects: [project, seedProject({ id: 'project-2', hidden: true })],
      hiddenProjectIds: ['project-1', 'project-2'],
      showHiddenProjects: true,
    });

    mockPatch.mockResolvedValueOnce({ ...project, hidden: false });

    useProjectsStore.getState().unhideProject('project-1');

    // Optimistic update.
    expect(useProjectsStore.getState().hiddenProjectIds).toEqual(['project-2']);
    expect(useProjectsStore.getState().showHiddenProjects).toBe(true);

    await flushAsync();

    expect(mockPatch).toHaveBeenCalledWith(
      '/projects?projectId=project-1',
      { hidden: false },
    );
    expect(useProjectsStore.getState().projects[0].hidden).toBe(false);
  });

  it('migrates legacy localStorage hidden ids on the first fetch and removes the key', async () => {
    window.localStorage.setItem(
      'conductor-hidden-project-ids',
      JSON.stringify(['legacy-1', 'legacy-default', 'unknown']),
    );

    const projects = [
      seedProject({ id: 'legacy-1' }),
      seedProject({ id: 'legacy-default', isDefault: true }),
      seedProject({ id: 'project-2' }),
    ];

    // The migration may trigger a refresh fetchProjects on success, so allow
    // any number of subsequent GETs to also succeed without crashing.
    mockGet.mockResolvedValue(projects);
    mockPatch.mockResolvedValue(undefined);

    await useProjectsStore.getState().fetchProjects();
    // Allow the migration's chained awaits to settle (PATCH + clear storage +
    // optional refresh fetch).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockPatch).toHaveBeenCalledTimes(1);
    expect(mockPatch).toHaveBeenCalledWith(
      '/projects?projectId=legacy-1',
      { hidden: true },
    );
    expect(window.localStorage.getItem('conductor-hidden-project-ids')).toBeNull();
  });
});

describe('useProjectsStore fetchProjects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    useProjectsStore.setState({
      projects: [],
      isLoading: false,
      error: null,
      selectedProjectId: null,
      hiddenProjectIds: [],
      showHiddenProjects: false,
    });
  });

  it('ignores stale fetchProjects responses when a newer refresh finishes first', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    let resolveSecond: ((value: unknown) => void) | null = null;

    mockGet.mockImplementation(() => {
      if (!resolveFirst) {
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      }
      if (!resolveSecond) {
        return new Promise((resolve) => {
          resolveSecond = resolve;
        });
      }
      throw new Error('Unexpected extra fetchProjects request');
    });

    const firstFetch = useProjectsStore.getState().fetchProjects();
    const secondFetch = useProjectsStore.getState().fetchProjects();

    resolveSecond?.([
      {
        id: 'project-new',
        name: 'Newest Order',
        sortOrder: 0,
      },
    ]);
    await secondFetch;

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual(['project-new']);

    resolveFirst?.([
      {
        id: 'project-old',
        name: 'Stale Order',
        sortOrder: 0,
      },
    ]);
    await firstFetch;

    expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual(['project-new']);
    expect(useProjectsStore.getState().isLoading).toBe(false);
    expect(useProjectsStore.getState().error).toBeNull();
  });

  it('ignores fetchProjects responses after the stored JWT changes', async () => {
    let resolveFetch: ((value: unknown) => void) | null = null;

    window.localStorage.setItem(JWT_STORAGE_KEY, 'jwt-old');
    mockGet.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const pendingFetch = useProjectsStore.getState().fetchProjects();

    window.localStorage.setItem(JWT_STORAGE_KEY, 'jwt-new');
    resolveFetch?.([
      {
        id: 'project-old',
        name: 'Old Session Project',
        sortOrder: 0,
      },
    ]);
    await pendingFetch;

    expect(useProjectsStore.getState().projects).toEqual([]);
    expect(useProjectsStore.getState().isLoading).toBe(false);
    expect(useProjectsStore.getState().error).toBeNull();
  });
});

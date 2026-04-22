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

  it('hides a project locally and clears it when selected', () => {
    useProjectsStore.setState({
      selectedProjectId: 'project-1',
      showHiddenProjects: true,
    });

    useProjectsStore.getState().hideProject('project-1');

    expect(useProjectsStore.getState().hiddenProjectIds).toEqual(['project-1']);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
    expect(useProjectsStore.getState().showHiddenProjects).toBe(false);
    expect(window.localStorage.getItem('conductor-hidden-project-ids')).toBe('["project-1"]');
    expect(window.localStorage.getItem('conductor-selected-project-id')).toBeNull();
  });

  it('clears a selected hidden project when hiding hidden cards again', () => {
    useProjectsStore.setState({
      selectedProjectId: 'project-1',
      hiddenProjectIds: ['project-1'],
      showHiddenProjects: true,
    });

    useProjectsStore.getState().toggleShowHiddenProjects();

    expect(useProjectsStore.getState().showHiddenProjects).toBe(false);
    expect(useProjectsStore.getState().selectedProjectId).toBeNull();
  });

  it('restores a locally hidden project', () => {
    useProjectsStore.setState({
      hiddenProjectIds: ['project-1', 'project-2'],
      showHiddenProjects: true,
    });

    useProjectsStore.getState().unhideProject('project-1');

    expect(useProjectsStore.getState().hiddenProjectIds).toEqual(['project-2']);
    expect(useProjectsStore.getState().showHiddenProjects).toBe(true);
    expect(window.localStorage.getItem('conductor-hidden-project-ids')).toBe('["project-2"]');
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

import { describe, expect, it } from 'vitest';
import { normalizeProject } from './store';

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

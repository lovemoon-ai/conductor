import type { Project } from '@prisma/client';

export function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    userId: 'user-1',
    name: 'Project',
    daemonHost: null,
    workspacePath: null,
    repoRoot: null,
    worktreeBranch: null,
    lastCommit: null,
    lastCommitAt: null,
    gitRemoteUrl: null,
    fileCount: null,
    sortOrder: 0,
    hiddenAt: null,
    mergeOptOut: false,
    collaborationId: null,
    metadata: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

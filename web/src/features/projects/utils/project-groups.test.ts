import { describe, expect, it } from 'vitest';
import type { Project } from '@/shared/types';
import { canMergeProjects, computeProjectGroups } from './project-groups';

const baseProject = (overrides: Partial<Project>): Project => {
  // Explicit `in` checks so callers can pass `null` to override the defaults
  // — `??` would otherwise coalesce null back to the default and silently
  // turn non-git fixtures into git fixtures.
  const pick = <K extends keyof Project>(key: K, fallback: Project[K]): Project[K] =>
    key in overrides ? (overrides[key] as Project[K]) : fallback;
  return {
    id: pick('id', 'project-1'),
    name: pick('name', 'My Project'),
    daemonHost: pick('daemonHost', 'daemon-a'),
    workspacePath: pick('workspacePath', '/workspace'),
    repoRoot: pick('repoRoot', '/workspace'),
    worktreeBranch: pick('worktreeBranch', 'main'),
    lastCommit: pick('lastCommit', null),
    gitRemoteUrl: pick('gitRemoteUrl', 'github.com/owner/repo'),
    fileCount: pick('fileCount', 10),
    sortOrder: pick('sortOrder', 0),
    hidden: pick('hidden', false),
    mergeOptOut: pick('mergeOptOut', false),
    isDefault: pick('isDefault', false),
    metadata: pick('metadata', null),
    taskStatusCounts: overrides.taskStatusCounts,
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
  };
};

describe('canMergeProjects', () => {
  it('merges two git projects sharing name and remote URL across daemons', () => {
    const a = baseProject({ id: 'a', daemonHost: 'daemon-a' });
    const b = baseProject({ id: 'b', daemonHost: 'daemon-b' });
    expect(canMergeProjects(a, b)).toBe(true);
  });

  it('refuses to merge projects with different names', () => {
    const a = baseProject({ id: 'a', name: 'Alpha' });
    const b = baseProject({ id: 'b', name: 'Beta' });
    expect(canMergeProjects(a, b)).toBe(false);
  });

  it('refuses to merge projects with different git remote URLs', () => {
    const a = baseProject({ id: 'a', gitRemoteUrl: 'github.com/owner/repo' });
    const b = baseProject({ id: 'b', gitRemoteUrl: 'github.com/forker/repo' });
    expect(canMergeProjects(a, b)).toBe(false);
  });

  it('refuses to merge non-git projects (no repoRoot) even when names match', () => {
    const a = baseProject({ id: 'p-a', repoRoot: null, gitRemoteUrl: null });
    const b = baseProject({ id: 'p-b', repoRoot: null, gitRemoteUrl: null });
    expect(canMergeProjects(a, b)).toBe(false);
  });

  it('refuses to merge a git project with a non-git project', () => {
    const a = baseProject({ id: 'p-a' });
    const b = baseProject({ id: 'p-b', repoRoot: null, gitRemoteUrl: null });
    expect(canMergeProjects(a, b)).toBe(false);
  });

  it('refuses to merge when one side has no gitRemoteUrl (legacy data)', () => {
    const a = baseProject({ id: 'p-a' });
    const b = baseProject({ id: 'p-b', gitRemoteUrl: null });
    expect(canMergeProjects(a, b)).toBe(false);
  });

  it('refuses to merge when either side has mergeOptOut set', () => {
    const a = baseProject({ id: 'a' });
    const b = baseProject({ id: 'b', mergeOptOut: true });
    expect(canMergeProjects(a, b)).toBe(false);
  });
});

describe('computeProjectGroups', () => {
  it('groups same-name same-remote git projects into one merged group', () => {
    const projects = [
      baseProject({ id: 'p-a', daemonHost: 'daemon-a' }),
      baseProject({ id: 'p-b', daemonHost: 'daemon-b' }),
    ];
    const groups = computeProjectGroups(projects);
    expect(groups).toHaveLength(1);
    expect(groups[0].isMerged).toBe(true);
    expect(groups[0].members.map((m) => m.id)).toEqual(['p-a', 'p-b']);
  });

  it('keeps single-member groups for same-name projects with different remotes', () => {
    const projects = [
      baseProject({ id: 'p-a', daemonHost: 'daemon-a', gitRemoteUrl: 'github.com/foo/bar' }),
      baseProject({ id: 'p-b', daemonHost: 'daemon-b', gitRemoteUrl: 'gitlab.com/foo/bar' }),
    ];
    const groups = computeProjectGroups(projects);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isMerged)).toBe(true);
  });

  it('keeps non-git projects as their own single-member groups', () => {
    const projects = [
      baseProject({ id: 'p-a', repoRoot: null, gitRemoteUrl: null }),
      baseProject({ id: 'p-b', repoRoot: null, gitRemoteUrl: null, daemonHost: 'daemon-b' }),
    ];
    const groups = computeProjectGroups(projects);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isMerged)).toBe(true);
  });

  it('uses the project id as the group key for single-member groups', () => {
    const projects = [
      baseProject({ id: 'p-only', repoRoot: null, gitRemoteUrl: null }),
    ];
    const groups = computeProjectGroups(projects);
    expect(groups[0].key).toBe('p-only');
  });

  it('uses a stable synthetic key for merged groups regardless of input order', () => {
    const projectsForward = [
      baseProject({ id: 'p-a', daemonHost: 'daemon-a' }),
      baseProject({ id: 'p-b', daemonHost: 'daemon-b' }),
    ];
    const projectsReversed = [
      baseProject({ id: 'p-b', daemonHost: 'daemon-b' }),
      baseProject({ id: 'p-a', daemonHost: 'daemon-a' }),
    ];
    const forward = computeProjectGroups(projectsForward);
    const reversed = computeProjectGroups(projectsReversed);
    expect(forward[0].key).toBe(reversed[0].key);
  });

  it('omits a project from a group once it opts out', () => {
    const projects = [
      baseProject({ id: 'p-a', daemonHost: 'daemon-a' }),
      baseProject({ id: 'p-b', daemonHost: 'daemon-b', mergeOptOut: true }),
    ];
    const groups = computeProjectGroups(projects);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => !g.isMerged)).toBe(true);
  });

  it('preserves input ordering of groups by anchoring to first occurrence', () => {
    const projects = [
      baseProject({ id: 'unrelated', name: 'Zeta', repoRoot: null, gitRemoteUrl: null }),
      baseProject({ id: 'p-a', name: 'Alpha', daemonHost: 'daemon-a' }),
      baseProject({ id: 'p-b', name: 'Alpha', daemonHost: 'daemon-b' }),
    ];
    const groups = computeProjectGroups(projects);
    expect(groups.map((g) => g.name)).toEqual(['Zeta', 'Alpha']);
  });
});

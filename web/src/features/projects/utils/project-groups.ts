import type { Project, ProjectGroup } from '@/shared/types';

/**
 * Decide whether two projects can be merged into the same cross-daemon group.
 *
 * Rules (locked in product spec):
 *  - Both projects must belong to the same user (caller-enforced).
 *  - Same `name`.
 *  - Neither has opted out of merging (`mergeOptOut !== true`).
 *  - Both must be git projects (`repoRoot` set).
 *  - Both must have a non-empty `gitRemoteUrl` and they must be equal.
 *
 * Anything else — non-git projects, missing remote URL (legacy data not yet
 * refreshed), or differing remotes — surfaces as standalone single-member
 * groups so users never see unrelated projects accidentally combined.
 */
export const canMergeProjects = (a: Project, b: Project): boolean => {
  if (a.id === b.id) return true;
  if (a.name !== b.name) return false;
  if (a.mergeOptOut === true || b.mergeOptOut === true) return false;
  const aIsGit = Boolean(a.repoRoot);
  const bIsGit = Boolean(b.repoRoot);
  if (!aIsGit || !bIsGit) return false;
  const aUrl = (a.gitRemoteUrl ?? '').trim().toLowerCase();
  const bUrl = (b.gitRemoteUrl ?? '').trim().toLowerCase();
  if (!aUrl || !bUrl) return false;
  return aUrl === bUrl;
};

/**
 * Group a flat project list into merged-display ProjectGroups.
 *
 * Single-member groups are emitted for everything that doesn't satisfy
 * `canMergeProjects`. The output preserves the input ordering by using the
 * earliest member's index within the source list as the group's anchor.
 */
export const computeProjectGroups = (projects: Project[]): ProjectGroup[] => {
  const groups: ProjectGroup[] = [];
  const groupIndexById = new Map<string, number>();

  for (let i = 0; i < projects.length; i += 1) {
    const project = projects[i];
    if (groupIndexById.has(project.id)) continue;

    const members: Project[] = [project];
    for (let j = i + 1; j < projects.length; j += 1) {
      const candidate = projects[j];
      if (groupIndexById.has(candidate.id)) continue;
      if (canMergeProjects(project, candidate)) {
        members.push(candidate);
      }
    }

    const sortedMemberIds = members
      .map((member) => member.id)
      .slice()
      .sort();
    // Single-member groups reuse the project's own id so callers (dnd-kit
    // sortable contexts, tests) can address them by their underlying project
    // id without extra translation. Merged groups get a synthetic key derived
    // from the member ids so it stays stable across re-renders.
    const groupKey = members.length > 1
      ? `merged:${project.name}:${sortedMemberIds.join('|')}`
      : project.id;

    const groupIndex = groups.length;
    for (const member of members) {
      groupIndexById.set(member.id, groupIndex);
    }

    groups.push({
      key: groupKey,
      name: project.name,
      members,
      isMerged: members.length > 1,
    });
  }

  return groups;
};

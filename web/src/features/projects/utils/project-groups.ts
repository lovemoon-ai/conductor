import type { Project, ProjectGroup } from '@/shared/types';
import { canMergeProjectsByFields } from '@/lib/projects/grouping';

/**
 * Decide whether two projects can be merged into the same cross-daemon group.
 *
 * Rules:
 *  - Both projects must belong to the same user (caller-enforced).
 *  - Same `name`.
 *  - Different `daemonHost` — the merge feature is explicitly about surfacing
 *    one card for the "same project, different machines" case. Two rows on
 *    the same daemon with the same name are a data anomaly and should stay
 *    separate.
 *  - Neither has opted out of merging (`mergeOptOut !== true`).
 *  - If BOTH sides have a `gitRemoteUrl`, they must be equal (case-insensitive
 *    after trim). This preserves the safety net that prevents two unrelated
 *    git repos that happen to share a folder name from accidentally fusing.
 *  - If either side is missing `gitRemoteUrl` (non-git workspace, daemon
 *    snapshot hasn't backfilled yet, etc.), we trust the name + daemonHost
 *    pairing and merge anyway. Users can override individual rows with
 *    `mergeOptOut` when they hit a false positive.
 *
 * Historical note: the original spec required both sides to be git projects
 * with matching remotes. That excluded a large class of legitimate workspaces
 * (non-git scratch dirs, projects created while the daemon couldn't read git
 * config, projects that pre-date the merge feature shipping). The relaxed
 * rule, combined with the daemon-reconnect backfill in
 * `web/src/lib/projects/backfill.ts`, lets the strict-equality safety net
 * kick in once both sides actually have remote URLs while still merging
 * everything else by name.
 */
export const canMergeProjects = (a: Project, b: Project): boolean => {
  if (a.id === b.id) return true;
  return canMergeProjectsByFields(a, b);
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

/**
 * Expand some members of a merged group to EVERY project in `allProjects` that
 * merges with any of them — hidden (archived) projects included.
 *
 * The project list only groups visible projects, so a group handed to a
 * dialog can be missing members. Settings shared across the group (task labels,
 * graph view) must still reach those members: readers that union across the
 * full group would otherwise resurrect a value from a member the write skipped
 * (e.g. a deleted label reappearing from a hidden daemon's project).
 *
 * Matching against every seed, not just the first, yields a superset of what
 * any single-anchor reader (`TaskItem`, the labels API) computes, because
 * `canMergeProjects` is pairwise and not guaranteed transitive.
 */
export const expandMergedProjectGroup = (
  seeds: readonly Project[],
  allProjects: readonly Project[],
): Project[] => {
  const expanded = allProjects.filter((candidate) =>
    seeds.some((seed) => canMergeProjects(seed, candidate)),
  );
  // Seeds not (yet) present in the store still count as members.
  const expandedIds = new Set(expanded.map((project) => project.id));
  return [...expanded, ...seeds.filter((seed) => !expandedIds.has(seed.id))];
};

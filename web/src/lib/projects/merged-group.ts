/**
 * Server-side resolution of a project's cross-daemon "merged group".
 *
 * The client computes groups from the full project list it already holds
 * (`features/projects/utils/project-groups.ts`). Server callers only ever have
 * one project in hand, so they need this lookup instead. It mirrors the pairwise
 * check `lib/tasks/remote-worktree.ts` does, generalized from "the sibling on
 * daemon X" to "every sibling".
 *
 * Membership is computed, never stored — see `lib/projects/grouping.ts` for the
 * predicate. A merged group is always same-`name`, so the candidate query can
 * filter on name and let the predicate reject the rest.
 */
import { db } from '@/lib/db';
import {
  canMergeProjectsByFields,
  type ProjectGroupingFields,
} from '@/lib/projects/grouping';

/**
 * Loose shape: `gitRemoteUrl` / `mergeOptOut` are absent on older deployments
 * whose `projects` table predates the merge feature. `canMergeProjectsByFields`
 * treats both as optional, so a stale row degrades to name+host matching rather
 * than throwing.
 */
export type MergedGroupProject = ProjectGroupingFields & {
  id: string;
  metadata?: string | null;
};

/**
 * Every project row in `project`'s merged group, including `project` itself,
 * which is always first so callers can treat it as the anchor.
 *
 * Returns just `[project]` when it has no daemon binding or nothing merges with
 * it — the same "group of one" the UI shows for an unmerged project.
 */
export const findMergedProjectMembers = async (
  userId: string,
  project: MergedGroupProject,
): Promise<MergedGroupProject[]> => {
  // A project that can't merge with anything (no daemon binding, or explicitly
  // opted out) short-circuits before touching the database.
  if (!(project.daemonHost ?? '').trim() || project.mergeOptOut === true) {
    return [project];
  }

  const candidates = (await db.project.findMany({
    where: { userId, name: project.name, id: { not: project.id } },
  })) as unknown as MergedGroupProject[];

  return [
    project,
    ...candidates.filter((candidate) =>
      canMergeProjectsByFields(project, candidate),
    ),
  ];
};

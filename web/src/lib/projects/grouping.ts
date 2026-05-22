/**
 * Pure helper deciding whether two projects belong to the same cross-daemon
 * "merged group". Mirrors the rules documented in
 * `web/src/features/projects/utils/project-groups.ts` — pulled into `lib/` so
 * both the React feature module and the server-side API routes can use the
 * same predicate without cross-importing feature code from `app/api`.
 *
 * Rules (see project-groups.ts for full prose):
 *  - Same `name`
 *  - Neither side has `mergeOptOut === true`
 *  - Both have a non-empty `daemonHost`
 *  - `daemonHost` values differ (a merged group is the "same project on
 *    different machines" case; same-host duplicates stay separate)
 *  - When both sides have a `gitRemoteUrl`, they must match after trim +
 *    lowercase. Missing `gitRemoteUrl` on either side does NOT block the
 *    merge — see the feature comment for the rationale.
 */
export type ProjectGroupingFields = {
  name: string;
  daemonHost: string | null | undefined;
  gitRemoteUrl?: string | null | undefined;
  mergeOptOut?: boolean | null | undefined;
};

export const canMergeProjectsByFields = (
  a: ProjectGroupingFields,
  b: ProjectGroupingFields,
): boolean => {
  if (a.name !== b.name) return false;
  if (a.mergeOptOut === true || b.mergeOptOut === true) return false;
  const aHost = (a.daemonHost ?? '').trim();
  const bHost = (b.daemonHost ?? '').trim();
  if (!aHost || !bHost) return false;
  if (aHost === bHost) return false;
  const aUrl = (a.gitRemoteUrl ?? '').trim().toLowerCase();
  const bUrl = (b.gitRemoteUrl ?? '').trim().toLowerCase();
  if (aUrl && bUrl && aUrl !== bUrl) return false;
  return true;
};

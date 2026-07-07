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
  daemonHost?: string | null;
  gitRemoteUrl?: string | null | undefined;
  mergeOptOut?: boolean | null | undefined;
};

/**
 * Collapse any GitHub SSH config alias to the canonical `github.com` host.
 * Users create aliases like `github-duinodu`, `github-dang217`, or
 * `github.com-work` in `~/.ssh/config` to juggle multiple accounts/keys. GitHub
 * identifies a repository solely by its `owner/repo` path, so the local alias
 * prefix carries no identity — we ignore it and let the path decide equality,
 * rather than maintaining a per-alias allowlist that breaks on the next new one.
 * Non-GitHub hosts (gitlab.com, self-hosted, GitHub Enterprise like
 * `github.mycompany.com`) are left untouched so unrelated repos never merge.
 */
const canonicalGitRemoteHost = (host: string): string => {
  const normalized = host.trim().toLowerCase();
  if (
    normalized === 'github.com' ||
    normalized.startsWith('github-') ||
    normalized.startsWith('github.com-')
  ) {
    return 'github.com';
  }
  return normalized;
};

const normalizeComparableGitRemoteUrl = (
  value: string | null | undefined,
): string => {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  const slashIndex = normalized.indexOf('/');
  if (slashIndex < 0) return normalized;
  const host = normalized.slice(0, slashIndex);
  const path = normalized.slice(slashIndex);
  return `${canonicalGitRemoteHost(host)}${path}`;
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
  const aUrl = normalizeComparableGitRemoteUrl(a.gitRemoteUrl);
  const bUrl = normalizeComparableGitRemoteUrl(b.gitRemoteUrl);
  if (aUrl && bUrl && aUrl !== bUrl) return false;
  return true;
};

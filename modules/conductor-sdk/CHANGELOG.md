# @love-moon/conductor-sdk

## 0.3.0

### Minor Changes

- be3b3cb: Project list now merges same-name git projects that share a remote URL across daemons into a single card.

  - `ProjectContext.snapshot()` (SDK) now captures the origin remote URL via `git config --get remote.origin.url` and exposes a `normalizeGitRemoteUrl` helper for callers that need their own equality comparison.
  - The daemon's `validate_project_path` response carries a new `git_remote_url` field. Old daemons that don't send it stay forward-compatible — the web server treats missing values as "unmergeable" so projects from those daemons render standalone until they're refreshed.
  - New web API surface:
    - `PATCH /api/projects { mergeOptOut: true }` opts a project out of auto-grouping (manual split for accidental name collisions).
    - `PATCH /api/projects { refresh: true }` re-runs the daemon validation handshake and back-fills `git_remote_url` for projects created before this feature.
    - `GET /api/issues?project_ids=a,b` fetches issues from multiple projects in one call; responses include `daemonHost` + `projectName` for cross-daemon attribution.
  - Schema: two new optional columns on `projects`: `git_remote_url` (nullable string) and `merge_opt_out` (boolean, default false). Run `pnpm -C web db:push` before upgrading.

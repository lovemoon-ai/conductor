# @love-moon/conductor-sdk

## 0.6.0

## 0.5.1

## 0.5.0

## 0.4.2

## 0.4.1

## 0.4.0

## 0.3.2

## 0.3.1

### Patch Changes

- 4e8d4e5: Include `CHANGELOG.md` in published npm tarballs.

  The `files` array in each package's `package.json` previously only
  listed the build output (`bin`/`src` for the CLI, `dist` for the
  modules). npm's `files` whitelist replaces the default include set,
  and CHANGELOG is not one of the auto-included files (only
  `package.json`, `README*`, `LICENSE*`, and `main` are unconditional).

  As a result, every release through 0.3.0 published tarballs with no
  CHANGELOG, so a consumer running `npm install` or unpacking the brew
  artifact had no way to see what changed in the version they just
  installed. The repo `cli/CHANGELOG.md` and the GitHub Release body
  remain the canonical source until 0.3.1 ships with this fix.

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

### Other Changes (retroactively documented)

The following changes shipped in `@love-moon/conductor-sdk@0.3.0` but
were merged without a `changeset` entry. See
`claw/lessons/arch_release-packages-pnpm-changesets-20260512.md` for
why this happened and the rule that every PR touching `modules/**`
must run `npm run changeset`.

- SDK helpers and types behind the new CLI `conductor project|issue|task`
  entity commands (RFC 0025). Programs that already depended on SDK
  project/issue/task surfaces gain a few stable convenience entry
  points; callers using only the public client API see no change.
  (`2e10756`)
- Reconnect: the SDK client survives the daemon-side websocket
  late-send-after-disconnect crash path (companion fix to the daemon
  change in `@love-moon/conductor-cli@0.3.0`). (`a3532cc`)
- Reconnect: stale `taskAttach` calls from a previously-bound fire
  process no longer establish ghost bindings. (`dc73be9`)

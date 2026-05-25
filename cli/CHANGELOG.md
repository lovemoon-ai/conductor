# @love-moon/conductor-cli

## 0.4.0

### Minor Changes

- 4ecc359: Publish the chat-web browser runtime and wire it into the CLI and AI SDK for
  ChatGPT and Gemini web sessions, including provider error handling and local
  development installation support.

  Ship app SDK realtime history catch-up and the CLI/AI SDK goal-mode and custom
  command runtime updates included in this release.

### Patch Changes

- d83cb65: Fix pnpm-installed daemon PTY support by allowing the `node-pty` build script during pnpm CLI updates and by failing native dependency repair with a clear error when pnpm has already recorded `node-pty` under ignored builds.
- Updated dependencies [4ecc359]
  - @love-moon/ai-sdk@0.4.0
  - @love-moon/conductor-sdk@0.4.0

## 0.3.2

### Patch Changes

- 8e1d4a8: Prefer the bundled Copilot platform executable before the JS entrypoint so Node
  20 installs do not fail with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`.
- Updated dependencies [8e1d4a8]
  - @love-moon/ai-sdk@0.3.2
  - @love-moon/ai-manager@0.3.2
  - @love-moon/conductor-sdk@0.3.2

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

- Updated dependencies [4e8d4e5]
  - @love-moon/conductor-sdk@0.3.1
  - @love-moon/ai-sdk@0.3.1
  - @love-moon/ai-manager@0.3.1

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

- 23ac015: Add `fire_tmux_mode` for the daemon. When enabled (via the `fire_tmux_mode: true`
  key in `~/.conductor/config.yaml` or the `CONDUCTOR_FIRE_TMUX_MODE=true`
  environment variable), each Fire process is launched inside a detached
  `tmux new-session -d` so that it runs under the tmux server with no
  parent/child relationship to the daemon. Restarting or terminating the daemon
  no longer affects running Fire processes; explicit `stop_task` requests use
  `tmux kill-session` to terminate the corresponding session.

  If `fire_tmux_mode` is enabled but `tmux` is not installed on PATH, the daemon
  logs a warning at startup and silently falls back to direct spawn instead of
  failing every `create_task` with ENOENT.

  If a tmux session fails to launch (e.g. duplicate session name, tmux server
  crashed), the daemon now reports a terminal status to the backend instead of
  leaving the task stuck on RUNNING.

  Session names embed a per-spawn uniqueness suffix
  (`conductor-fire-<taskId>-<base36-time><rand>`) so a re-spawn of the same task
  id while a prior session is still alive does not collide. The daemon also runs
  a periodic best-effort liveness reaper (default every 30s; override via
  `config.TMUX_LIVENESS_POLL_MS`) that walks tmux-mode entries in
  `activeTaskProcesses` and removes any whose session no longer exists, so the
  in-memory map does not accumulate stale entries when Fire exits naturally
  inside its session.

### Other Changes (retroactively documented)

The following changes shipped in `@love-moon/conductor-cli@0.3.0` but were
merged without a `changeset` entry and so didn't make it into the
auto-generated section above. See
`claw/lessons/arch_release-packages-pnpm-changesets-20260512.md` for the
process gap and the rule that every PR touching `cli/**` or `modules/**`
must run `npm run changeset`.

**New CLI commands**

- `cli`: `conductor project|issue|task` entity commands (RFC 0025). Adds
  scriptable CLI access to project/issue/task CRUD against the connected
  daemon. (`2e10756`)
- `cli`: `conductor project` accepts `--daemon-host` to disambiguate
  same-named projects across multiple daemons. (`08eefee`)
- `cli`: `conductor project list` now prints a daemon column. (`552731b`)

**Daemon — Fire tmux mode (companion to `fire_tmux_mode`)**

- Daemon now `tmux send-keys`-friendly: env vars are propagated via
  `tmux -e` flags so the Fire process inherits the spawn environment.
  (`3cd3022`)
- Live Fire output is now visible via `tmux attach` thanks to a `tee`
  inside the session shell. (`f07fbc6`)
- `stop_task` and `cleanup_task_worktree` now reap orphan tmux sessions.
  (`1f7ef28`)
- A killed tmux-mode task reports `KILLED` directly from the daemon
  instead of waiting on Fire to flip the status. (`59c6472`)
- `restart_task` clears stale tmux entries before re-spawning and refuses
  with a clearer error if the session can't be acquired. (`c659663`)

**Daemon stability**

- Fix: reconcile / stale-recovery no longer kills `init` successor tasks
  that haven't received their initial websocket message yet. (`d9258ba`)
- Fix: late websocket send after disconnect no longer crashes daemon
  restart. (`a3532cc`)
- Fix: stale fire task attach is now guarded against double-binding.
  (`dc73be9`)

**Worktree**

- Worktree folders are now named by branch (slugified) rather than by
  the task id, making them human-meaningful inside repos with many
  concurrent tasks. (`ed124b5`)
- The worktree scanner now skips symlinks that are git-tracked, so user
  symlinks inside a worktree don't get treated as candidates. (`5281952`)

**Quota / accounts UI**

- Codex quota snapshots are now restored from the daemon cache on
  refresh, so the daemon page doesn't blank out while a fresh fetch is
  in flight. (`130bd93`)

**Internal refactor (no consumer API change)**

- `modules/ai-sdk`: resume logic has been split into per-provider
  modules under `src/resume/<provider>.js`. The public exports
  (`createAiSession`, `BUILT_IN_BACKENDS`, etc.) are unchanged.
  Source-level only; the published `@love-moon/ai-sdk` version pinned
  in `cli@0.3.0`'s manifest is still `0.2.42`, so consumer behavior is
  identical to before — the refactor will reach npm with the next
  ai-sdk release that includes a `changeset`. (`846f05a`)

### Patch Changes

- Updated dependencies [be3b3cb]
  - @love-moon/conductor-sdk@0.3.0

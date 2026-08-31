# @love-moon/conductor-cli

## 0.11.0

### Minor Changes

- c987457: Allow creating a project whose workspace path does not exist yet.

  The daemon now accepts `create_if_missing` on `validate_project_path` and will
  `mkdir -p` the workspace before snapshotting it, advertising the new
  `project_path_create` capability. In the web Create Project dialog a missing
  path no longer dead-ends: it offers "Create this directory and continue", so a
  typo still fails loudly instead of silently creating the wrong folder.
  `conductor project create` gains `--create-workspace` for the same behavior.

- ccf902d: Add daemon sharing so a host can invite other conductor accounts to run tasks on their machine.

  A host daemon can create share invitations from the web settings page. Each invite is scoped to one guest user and carries a `allow_cli_list` whitelist. When the guest accepts, the host daemon spawns an isolated guest daemon with a dedicated workspace and token; the guest sees only their own tasks and cannot access the host's projects or files outside the shared workspace.

  Guest daemons are supervised by the host daemon: if the host restarts, guest configs are regenerated from the backend on the next reconcile; revoking a share stops the guest daemon and removes its workspace.

  This changes the agent-token schema (a new `scope` column is required on the backend) and adds `conductor_guest`, `allow_cli_list`, and `daemon_name` handling to the guest config path.

### Patch Changes

- 30afccc: Make the claude backend usable when conductor runs as root.

  Claude Code refuses `bypassPermissions` / `--dangerously-skip-permissions` under
  root unless `IS_SANDBOX=1` or `CLAUDE_CODE_BUBBLEWRAP` is set, so every claude
  turn died immediately on root installs (docker, CI, bare VPS). Both routes a
  claude command takes are now root-aware, sharing one check
  (`isClaudeRootPermissionRestricted`, which mirrors claude's own gate):

  - The agent-SDK session downgrades the permission mode to `acceptEdits` (auto
    mode) and stops passing `allowDangerouslySkipPermissions`.
  - The daemon's tool-preset PTY path rewrites the configured `allow_cli_list`
    command via `resolveClaudeCommandForRoot`, using the same env the spawned
    child receives, so a per-task `IS_SANDBOX=1` opt-out is honored.
  - `conductor config` no longer writes `--dangerously-skip-permissions` into a
    config generated on a root machine.

  The mode is also configurable now: `claude --permission-mode acceptEdits` in
  `allow_cli_list` is lifted out of the command string. An unrecognized mode still
  falls back to the default instead of failing, but logs a warning at session boot.

  ai-sdk gains three exports: `isClaudeRootPermissionRestricted`,
  `resolveClaudeCommandForRoot`, `resolveClaudePermissionPolicy`.

- a3c41dd: Document every supported key in the config file `conductor config` generates.

  The generated `config.yaml` only ever contained six keys, so nothing told a new
  user that the other fifteen existed. They are now all present as commented-out
  entries carrying their default value and env-var override, grouped into
  Connection / Coding CLIs / Environment / Daemon behaviour / Optional features:

  - `websocket_url`, previously written only when device authorization returned one
  - `pre_prompt`, `custom_commands`, `cdp_user_data_dir`
  - `remote_exec`, `fire_tmux_mode`, `auto_update`, `auto_update_respawn`,
    `update_window`
  - `ai_manager.codex.auth_json`, `serve_ai.{host,port,backend,api_key}`,
    `channels.feishu.*`
  - `envs.no_proxy`, `envs.DEEPSEEK_API_KEY`, `envs.DEEPSEEK_BASE_URL` alongside
    the proxy keys and `AISDK_PROVIDER_PATH` that were already shown

  Three notes correct documentation that would otherwise mislead. The commented
  `websocket_url` example is derived from this install's own `backend_url` (via
  the same rule as `ConductorConfig.resolvedWebsocketUrl`) instead of naming the
  official host, so a self-hosted user who uncomments it is not pointed at
  someone else's server. `daemon_name` is flagged as the one key whose precedence
  is inverted — the config value wins over `CONDUCTOR_DAEMON_NAME`. `log_level`
  is marked as validated on load but not yet consumed by any component.

  Behaviour is unchanged: the same six keys are still written uncommented, and
  the daemon still derives its own WebSocket URL from `backend_url` regardless of
  the `websocket_url` key.

- ccf902d: Refuse `--force` daemon restart when it would take over an unrelated daemon instance.

  Previously `conductor daemon --force` blindly replaced any existing lock, which could kill a daemon belonging to a different conductor home, backend URL, or agent token. The lock now stores an identity fingerprint (home directory, backend URL, agent token prefix, and daemon name) and `--force` only overwrites when the fingerprint matches. A mismatch reports the running daemon's identity and exits with code 7.

  This makes `--force` safe for "restart my own stuck daemon" while preventing accidental cross-instance takeovers.

- 884945c: Keep every task in a multi-agent group in one working directory. Creating a
  task with several agents and `worktree` enabled put the worker in
  `.conductor/worktrees/<branch>/` but pinned each reviewer to the project root,
  so reviewers read the base branch instead of the worker's changes. Reviewers
  now inherit the worker's worktree.

  Reviewers join as reuse-only members: they carry the full worktree identity —
  so archiving one member no longer deletes a directory its siblings are still
  running in — but never run `git worktree add` themselves. The daemon
  additionally serializes worktree preparation per on-disk root, so concurrent
  group members can no longer race on creating the same branch, and treats a
  worktree as ready only once preparation has fully completed rather than as soon
  as `.git` appears.

  Two new optional daemon environment variables:
  `CONDUCTOR_WORKTREE_REUSE_WAIT_TIMEOUT_MS` (default `180000`) and
  `CONDUCTOR_WORKTREE_REUSE_POLL_INTERVAL_MS` (default `250`).

- Updated dependencies [30afccc]
  - @love-moon/ai-sdk@0.11.0
  - @love-moon/conductor-sdk@0.11.0

## 0.10.0

### Minor Changes

- 43c4f87: Runtime health preflight and agent schedule access control. The daemon now
  advertises positive backend runtime health (`x-conductor-runtime-health`) so the
  backend can reject task creation with `503 runtime_unavailable` before any
  timeline activity, and adds `disable_built_in_cli_list` to opt out of built-in
  SDK backends. The SDK attributes agent-originated scheduled-message calls with
  `X-Conductor-Actor: agent` so per-task `agent_schedule_access`
  (full/read_only/blocked) can govern `conductor task schedule` from agents while
  human/UI calls stay unrestricted.

### Patch Changes

- 43c4f87: Fix `conductor fire` and `conductor diagnose` with an explicit `--config-file`
  resolving `agent_token`/`backend_url` from daemon-injected `CONDUCTOR_*` env
  instead of the file. Fire could dial the file's websocket with the inherited
  token and loop on `4002 invalid-token`; diagnose queried the wrong backend and
  404'd. An explicit config file now wins over inherited env, matching the
  daemon's behavior.
- 43c4f87: Fix `conductor update` installing into the wrong npm prefix.
- Updated dependencies [43c4f87]
- Updated dependencies [43c4f87]
  - @love-moon/ai-sdk@0.10.0
  - @love-moon/conductor-sdk@0.10.0

## 0.9.0

### Minor Changes

- 3a499cc: Add `conductor remote-exec` for running a single command on another daemon's
  host, over a new `remote_exec_request`/`remote_exec_response` daemon protocol
  pair gated by a `remote_exec` capability. Supports `--workspace`, `--env`,
  `--timeout` with automatic polling for long commands, `--kill-on-timeout`, and
  ssh-style exit codes. Hosts can decline with `remote_exec: false` in the config.
- a15b55d: Add per-turn multi-image and local context-file inputs, plus authenticated attachment materialization from Conductor Web to the executing daemon.

### Patch Changes

- Updated dependencies [a15b55d]
  - @love-moon/ai-sdk@0.9.0
  - @love-moon/conductor-sdk@0.9.0

## 0.8.0

### Minor Changes

- 959dd1d: Add project-configured worker and reviewer task groups, task-group discovery in
  the SDK and `conductor task group`, and a lightweight daemon protocol for
  refreshing the project agent registry.
- fe76139: Add `conductor task create` for creating app tasks with title, prompt, backend,
  project resolution, and optional parent task-card grouping. App tasks now
  require an online compatible daemon, and grouping results are exposed to
  callers so partial success is visible without retrying task creation.

### Patch Changes

- Updated dependencies [959dd1d]
- Updated dependencies [fe76139]
  - @love-moon/conductor-sdk@0.8.0
  - @love-moon/ai-sdk@0.8.0

## 0.7.7

### Patch Changes

- 400f3a7: Report a terminal task status when a stop request finds no active process, so a
  task whose Fire already died converges instead of sitting in `killing` forever.

  Drop queued terminal status events before an in-place restart reuses a working
  directory. The durable upstream outbox lives inside that directory, so an
  undelivered `KILLED` from the previous run was flushed on startup and killed the
  task that had just finished resuming.

- 67498dc: Report a Fire that dies inside its tmux session instead of leaving the task
  hanging. In tmux mode the daemon's child is the short-lived `tmux new-session`
  client, not the Fire, so an abnormal death (crash, OOM, SIGKILL) went unreported
  and the task sat at `running` until reconcile relabelled it as a user stop. The
  Fire now records its own exit code into its log under a per-launch nonce, and the
  liveness reaper classifies the death from that marker and publishes a terminal
  status with the real cause.
- Updated dependencies [400f3a7]
  - @love-moon/conductor-sdk@0.7.7
  - @love-moon/ai-sdk@0.7.7

## 0.7.6

### Patch Changes

- 7bbb412: Add `CONDUCTOR_HOME` support for relocating user-level configuration, logs,
  Fire locks, sessions, update metadata, and AI manager caches while leaving
  project-scoped `.conductor` directories and Fire task markers in place.

  Migrate device authorization to `conductor.conductor-ai.top` while preserving
  compatibility with the legacy official endpoint and self-hosted backends.

- Updated dependencies [7bbb412]
  - @love-moon/conductor-sdk@0.7.6
  - @love-moon/ai-sdk@0.7.6

## 0.7.5

### Patch Changes

- Updated dependencies [f91a5df]
  - @love-moon/ai-sdk@0.7.5
  - @love-moon/conductor-sdk@0.7.5

## 0.7.4

### Patch Changes

- Updated dependencies [d5eca1c]
- Updated dependencies [d5eca1c]
  - @love-moon/ai-sdk@0.7.4
  - @love-moon/conductor-sdk@0.7.4

## 0.7.3

### Patch Changes

- 689fd07: Normalize daemon backend HTTP URLs and extend the watchdog self-heal budget.
- Updated dependencies [689fd07]
  - @love-moon/ai-sdk@0.7.3
  - @love-moon/conductor-sdk@0.7.3

## 0.7.2

### Patch Changes

- Updated dependencies [80c5255]
  - @love-moon/conductor-sdk@0.7.2
  - @love-moon/ai-sdk@0.7.2

## 0.7.1

### Patch Changes

- Updated dependencies [3f35925]
  - @love-moon/conductor-sdk@0.7.1
  - @love-moon/ai-sdk@0.7.1

## 0.7.0

### Minor Changes

- 689fc50: Add scheduled message management APIs and conductor task schedule list/create/delete commands.

### Patch Changes

- Updated dependencies [689fc50]
  - @love-moon/conductor-sdk@0.7.0
  - @love-moon/ai-sdk@0.7.0

## 0.6.1

### Patch Changes

- Updated dependencies [650fc55]
  - @love-moon/ai-sdk@0.6.1
  - @love-moon/conductor-sdk@0.6.1

## 0.6.0

### Minor Changes

- bcc80b5: Initialize Git submodules automatically when preparing task worktrees.

### Patch Changes

- @love-moon/conductor-sdk@0.6.0
- @love-moon/ai-sdk@0.6.0

## 0.5.1

### Patch Changes

- 39a49fc: fix: reclaim orphaned chat-web browser and cap chat-web task lifetime

  chat-web persists one Chromium profile per provider, guarded by a per-profile
  SingletonLock. A task whose browser was not cleaned up (e.g. the ai-sdk worker
  was SIGKILLed) left an orphaned Chromium holding that lock, so the next task for
  the same provider failed to launch with `Opening in existing browser session`.

  - chat-web now reclaims stale/orphaned profile locks before launching (kills an
    orphan whose owner process is gone, clears dead locks) and refuses with a
    clear `ProfileLockedError` when a genuine live chat still holds the profile.
  - The ai-sdk worker now closes its session (and browser) on SIGTERM/SIGINT and
    bounds the close so it can't hang, preventing browser leaks on shutdown.
  - conductor fire caps a chat-web task's active lifetime (default 24h,
    `CONDUCTOR_CHATWEB_MAX_ACTIVE_MS`) and auto-stops it as
    `KILLED / max_active_duration`; chat history is preserved.

- Updated dependencies [39a49fc]
  - @love-moon/ai-sdk@0.5.1
  - @love-moon/conductor-sdk@0.5.1

## 0.5.0

### Patch Changes

- @love-moon/conductor-sdk@0.5.0
- @love-moon/ai-sdk@0.5.0

## 0.4.2

### Patch Changes

- e8936fb: Upgrade the GitHub Copilot SDK permission protocol so Copilot-backed tasks auto-approve tool calls with current Copilot CLI releases instead of failing with `unexpected user permission response`.
- Updated dependencies [e8936fb]
  - @love-moon/ai-sdk@0.4.2
  - @love-moon/conductor-sdk@0.4.2

## 0.4.1

### Patch Changes

- aada753: Add explicit ChatGPT and Gemini web backend aliases, expose project icon
  configuration in generated CLI settings, and default browser-backed session
  checks to headed mode for reliable authenticated detection.
- Updated dependencies [aada753]
  - @love-moon/ai-sdk@0.4.1
  - @love-moon/conductor-sdk@0.4.1

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with an additional `Commits` section for each released version.
This project follows [Semantic Versioning](https://semver.org/) where practical.

## [0.2.38] - 2026-04-20

### Changed

- Moved daemon restart out of each daemon list item and into a dedicated
  Danger zone card at the bottom of the Daemon page, keeping the high-impact
  restart action away from routine daemon browsing.
- Homebrew release generation now uses the tracked Formula template and
  release notes extracted from this changelog, so archive releases can publish
  consistent notes and generated Formula assets.

### Fixed

- Fixed daemon-launched tasks so `${PWD}` in backend-specific `pre_prompt`
  expands to the task workspace selected during `create_task`, including
  isolated worktrees, instead of inheriting the directory where
  `conductor daemon` was started.
- Fixed the Homebrew launcher path and added coverage for the symlinked
  launcher shape used by installed CLI archives.

### Commits

- `76a675a` fix homebrew launcher path
- `05a4988` test homebrew launcher symlink
- `7849808` move daemon restart action
- `376044b` simplify daemon restart card
- `eafcca0` use homebrew formula template
- `2f3a233` use changelog release notes
- `6bf5515` fix daemon task pwd

## [0.2.37] - 2026-04-18

### Added

- Added a Restart button on each Connected Daemon card in Settings: it asks
  the daemon to upgrade the `conductor` CLI to the latest version and respawn
  itself, so operators can roll out CLI updates without SSH. Gated behind a
  new `restart_daemon` capability, so older daemons that do not understand
  the command simply hide the button.
- Added `POST /api/agents/[host]/restart`: validates the target version with
  Zod (`latest` or semver), rejects hosts that do not advertise
  `restart_daemon` with `409`, and dispatches the event through
  `realtimeHub.sendToAgentHost` scoped to the requesting user.
- Daemon now handles the `restart_daemon` realtime event: sends an
  `agent_command_ack` for observability, fetches the latest version, runs
  the existing install/verify/native-dep-repair pipeline, and respawns with
  lock handoff. Install failures fall back to a plain restart.

### Changed

- `restartDaemonProcess` always daemonizes respawn output to
  `~/.conductor/logs/conductor-daemon.log` instead of re-attaching to the
  current TTY, avoiding an orphaned daemon when the command is issued
  against a `conductor daemon` process started in the foreground.
- Auto-update respawn stays opt-in behind `CONDUCTOR_AUTO_UPDATE_RESPAWN` /
  `auto_update_respawn` in `~/.conductor/config.yaml`: auto-update will
  install the new version but will not respawn unless operators explicitly
  enable it. This preserves the pre-existing "install, wait for manual
  restart" behaviour while the new restart path is rolled out.

### Fixed

- Fixed a silent config-key casing mismatch in `conductor-daemon.js`: the
  launcher wrapper was passing `restartLauncherScript` (camelCase) but the
  daemon reads `RESTART_LAUNCHER_SCRIPT` (UPPER_SNAKE), so respawn was
  always erroring with "Missing daemon restart launcher script" in
  production. Keys are now consistent.

### Commits

- `c656a7d` add daemon restart from web settings

## [0.2.36] - 2026-04-18

### Added

- Added `ai-manager` web dashboard at `/app/ai-manager` reachable from any
  daemon card in Settings, showing install status, network reachability, and
  5h / weekly quota for `codex`, `claude`, and `kimi` on the selected daemon.
- Added Codex account switcher: list authorized `auth.json` profiles configured
  under `ai_manager.codex.auth_json` in `~/.conductor/config.yaml` and
  atomically swap `~/.codex/auth.json` between them, with a confirmation
  dialog warning that already-running codex sessions keep the previous token.
- Added Kimi quota provider in `@love-moon/ai-manager`: refreshes expired
  OAuth access tokens via `auth.kimi.com/api/oauth/token` and persists them
  back to `~/.kimi/credentials/kimi-code.json`.
- Added `ai_manager_request` / `ai_manager_response` realtime envelope on the
  agent gateway and a `requestAiManager()` helper for API routes; waiters are
  bound to `{userId, agentHost}` so a stray response cannot satisfy another
  user's pending call.

### Changed

- Settings page now links each Connected Daemon card to `/app/ai-manager` for
  the corresponding host; the dedicated AI Manager entry has been removed
  from the sidebar.
- `AiManager.getConfig()` now uses an mtime-based cache instead of a process-
  lifetime memoization, so edits to `~/.conductor/config.yaml` take effect
  without restarting the daemon.
- `--version` parsing in `@love-moon/ai-manager` now extracts a normalized
  semver, so `codex / claude / kimi` all render identically.
- Daemon `status` now skips the network probe for tools that are not
  installed, removing duplicate "not installed" badges in the UI and avoiding
  a wasted outbound timeout per missing tool.

### Removed

- Removed the personal-access-token card from the home page and the API
  Token block from the Settings page; both were redundant after the move to
  device-flow login.

### Fixed

- `/api/ai-manager/quota?tool=kimi` no longer falls through to fetching all
  three tools.
- `/api/ai-manager/*` rejects `conductor-fire-*` hosts with `400` instead of
  letting the realtime waiter time out at 15s.
- The `AiManagerPanel` default-host fallback now skips `conductor-fire-*`
  hosts so direct navigation to `/app/ai-manager` does not pick an ephemeral
  fire process.

### Security

- _None._

### Commits

- `54d9de4` add ai-manager dashboard with kimi quota and codex switcher

## [0.2.35] - 2026-04-17

### Added

- Added Issues as a first-class workflow for project planning, including issue CRUD APIs, an Issues page, board/list views, status changes, drag ordering, and issue-linked AI task creation.
- Added `pre_prompt` support for `conductor fire` configuration so backend-specific session instructions can be loaded from the local config file.
- Added per-task session persistence for `conductor fire` sessions backed by the AI SDK.
- Added richer fire working-status forwarding, including tool, item, turn, and event metadata.

### Changed

- Refactored AI task creation and task response serialization so issue task creation, normal task creation, and restart flows share the same behavior.
- Updated project list ordering to use the same drag-and-drop runtime used by the Issues board.
- Improved project/task navigation, project cards, task cards, worktree sync support, and runtime detail display.

### Fixed

- Fixed issue-linked task rollout compatibility so mixed-version deployments can fall back when newer task or issue columns are not available yet.
- Fixed `conductor fire` task restart, provider loading, daemon binding, stale binding, and task removal edge cases.
- Fixed CLI release-blocking test failures caused by an incomplete `conductor-fire` export block and daemon tests racing backend initialization.

### Removed

- Removed the remaining task grid-view dead code.

### Security

- _None._

### Commits

- `7972beb` update project task navigation
- `21b407b` merge project task navigation
- `a7048c8` update project list interactions
- `6ccf146` add task status tags on project card and project/daemon tags on task card
- `2f23e72` add sync_branch support for worktree creation
- `df595bd` remove grid view from task list page
- `0f391ac` remove remaining grid view dead code in TaskItem
- `9b5bbe0` fix fire task restart by persisting daemonName in metadata
- `7a94a84` fix project ordering rollout and worktree sync
- `545764b` merge project ordering and worktree sync
- `bfe903c` add skip lock for debug daemon
- `0be97e9` fix runtime details fields
- `0317d20` fix stale fire binding
- `2c8d7c9` fix task remove bug
- `79e5c13` fix fire provider loading and worktree cleanup
- `d31d639` fix fire task daemon binding
- `90f5875` feat: add issues module with full CRUD, DB schema, UI integration, and task API refactoring
- `e4e887b` feat(fire): forward mira-sdk enriched working status fields to conductor server
- `c5ff374` feat(fire): per-task session persistence for mira-sdk
- `80e5e53` feat: load pre_prompt from conductor config for ai sessions
- `0301c3f` fix: address review findings — schema fallback cleanup and consistency
- `20327e0` fix conflict
- `140f89d` Merge pull request #2 from lovemoon-ai/feat/issue

## [0.2.34] - 2026-04-10

### Added

- Task creation now allows `conductor fire` hosts to create tasks on daemon-bound projects without requiring the daemon to be online.

### Changed

- Task rename gesture changed from swipe to long-press inline editing.
- Tasks are now scoped to the selected project.

### Fixed

- Fixed `conductor fire` sharing the same agentHost as the daemon, which caused Codex sessions to initialize twice and `stop_task` to be routed to the wrong process.
- Fixed `conductor fire` not exiting after a task is deleted from the web UI, caused by the SDK durable outbox retrying a `task_status_update` against a deleted task.
- Fixed task dialog backend selection not matching the correct daemon.
- Fixed create project dialog not showing all online daemons.
- Added missing Prisma migration for project daemon binding columns.

### Commits

- `c5a1233` fix fire sharing agentHost with daemon causing double init and stuck exit
- `a2f454d` fix bug in conductor-fire.js
- `ee0722b` update .conductor/config.yaml
- `031ea02` scope tasks to selected project
- `86cfe28` merge task dialog backend selection fix
- `a1d4e4b` fix task dialog backend selection
- `c5bbfda` merge task share links
- `25cb8a7` update task share links
- `ec3c92a` add configuredDaemonName to agentHost
- `6935814` change task rename from swipe to long-press inline editing
- `088ebaf` fix(web): show all online daemons in create project dialog
- `28482eb` fix(prisma): add missing migration for project daemon binding
- `db7f9bf` Merge branch 'feat/refactor_projeect' — release 0.2.33

## [0.2.33] - 2026-04-09

### Added

- Projects are now first-class: a project can bind to a specific daemon host and workspace path, each user has a default project, and project metadata (worktree branch, last commit, file count) is surfaced through the API.
- Added `scripts/run_gemma4_ollama.sh` helper to launch Gemma 4 via Ollama for local backend experimentation.

### Changed

- Refactored the web app to a feature-based architecture (`features/` + `shared/`), co-locating each feature's store, components, hooks, and utilities. Internal reorganization only — no user-visible change.
- Projects and agents API responses now emit both `camelCase` and `snake_case` fields so future API renames cannot silently leave the UI state undefined; the client also normalizes both casings defensively.

### Fixed

- Fixed `DELETE /api/tasks/[taskId]` blocking for 30 seconds on manual-fire worktree tasks, which made task deletion look broken.
- Fixed task creation failing right after creating a new project because the project API response was missing `camelCase` fields the client relied on.
- Fixed backend alias runtime discovery when the requested alias did not appear verbatim in a daemon's supported backend list.
- Fixed `conductor fire` falling back to an empty daemon host when no explicit host was configured, now uses `os.hostname()`.
- Hardened `worktreeId` handling in the daemon against path traversal.
- Fixed parallel task-stop handling and optimized the tasks query path.

### Removed

- Removed subscription tiers, payment limits, and task quotas. All users now have unrestricted access to tasks and agents.

### Security

- _None._

### Commits

- `351522b` fix(web): DELETE /api/tasks/[taskId] no longer waits 30s on worktree stop
- `17418e7` feat(web): add normalizer layer to projects and agents stores
- `eb3d428` docs(lessons): project API snake_case regression broke CreateTaskDialog
- `441e7fc` fix(web): project POST/GET response must include camelCase fields
- `b267a5f` refactor(web): phase 9 — final cleanup
- `9fb3234` refactor(web): phase 8 — flatten global components
- `31f35cb` refactor(web): phase 7 — features/agents/
- `a91e7c9` refactor(web): phase 6 — features/terminal/
- `c329bbc` refactor(web): phase 5 — features/chat/
- `b065ee7` refactor(web): phase 4 — features/projects/
- `9747f79` refactor(web): phase 3 — features/tasks/
- `6a362b4` refactor(web): phase 2 — features/realtime/
- `6f5eb6e` refactor(web): phase 1 — features/auth/
- `c5e7acd` refactor(web): phase 0 — extract shared/ foundation
- `951c734` fix second review: worktreeId sanitization, serializeProject dedup, legacy project UX
- `e5ebf86` fix review issues: null constraint guard, parallel stop, fire hostname fallback, query optimization
- `54eef22` remove subscription tiers, payment limits, and task quotas
- `1c5a355` add gemma4 ollama helper
- `af118b2` fix backend alias runtime discovery

---

## [0.2.32] - 2026-04-02

### Added

- Added shareable conversation links — swipe left on a task and tap Share to generate a public, read-only link that anyone can view without logging in.
- Share links can be revoked by the task owner at any time.
- Share links support optional expiration dates for time-limited access.

### Changed

- Improved AI turn status handling in the AI SDK for more reliable session state transitions.
- Improved help message display when using external AI SDK providers.

### Fixed

- Fixed `conductor daemon --force` flag not working correctly when reclaiming an existing daemon host.
- Fixed fire task kill convergence issue where a reconnecting daemon could overwrite a pending kill request.

### Removed

- _None._

### Security

- _None._

### Commits

- `5e303e6` add share conversation
- `560eabc` improve ai turn status handling
- `90ec97d` fix fire kill convergence
- `1251cbd` fix bug in conductor daemon --force
- `4ae7ff5` update help message when using extern provider
- `ac0c938` update claw/sop/06_release.md

---

## [0.2.31] - 2026-03-30

### Added

- Added support for loading external AI SDK providers through `AISDK_PROVIDER_PATH`, so teams can plug private runtimes into Conductor without forking the built-in CLI or AI SDK.
- Added support for creating a new task from a running manual `conductor fire` task through the restart flow when switching backends, instead of waiting for the original task to stop first.

### Changed

- Improved backend discovery and validation for custom AI SDK providers, including alias resolution from CLI config and clearer provider compatibility checks.
- Improved disk-backed session store initialization in `@love-moon/conductor-sdk` so the lock directory is created automatically before session state is persisted.

### Fixed

- Fixed task recovery after web server restarts by restoring task-to-agent bindings from the database, preventing active tasks from remaining stuck in `init`.
- Fixed AI SDK session metadata propagation so remote and resumed sessions report the correct model and model-provider information.
- Fixed restart controls for manual fire tasks so creating a new task is no longer incorrectly blocked while the source task is still running.

### Removed

- _None._

### Security

- _None._

### Commits

- `edc7d25` allow running fire task to create new task via restart
- `8b3abbf` fix: remove fire task running state restriction for new task
- `4c9b43c` fix: restore task bindings from db on server startup to prevent stuck init tasks
- `9a83106` fix ai sdk model metadata
- `30be88b` update
- `7e0bd83` support external ai sdk providers

---

## [0.2.30] - 2026-03-26

### Added

- _None._

### Changed

- Improved CLI dependency repair during `pnpm`-based updates so native `node-pty` rebuilds and daemon setup recover more reliably when operators upgrade Conductor in place.
- Tightened the operator release and production deployment SOPs so the documented ship path better matches the current npm and Volc workflows.

### Fixed

- Fixed a CLI update regression that could leave `node-pty` partially repaired after install, causing daemon startup or native dependency validation to fail on upgraded machines.
- Fixed task kill convergence in the API so the app stops polling decisively once a task is confirmed dead, reducing stuck "stopping" states after termination.

### Removed

- _None._

### Security

- _None._

### Commits

- `13a61ad` fix pnpm node-pty update repair
- `3888d69` improve task kill convergence
- `e6a71ad` update 06_release.md

---

## [0.2.29] - 2026-03-26

### Added

- Added task restart controls so operators can restart an existing task from the task view and choose whether to continue in place or branch from it.

### Changed

- Refined restart, branch, and kill actions in the task list with clearer confirmation flows and more recognizable branch icon treatment.
- Updated the CLI daemon packaging to use the `ai-bridge` package path expected by the current runtime setup.

### Fixed

- Fixed `conductor fire` task restarts so they reconnect through the original execution daemon instead of a stale daemon binding.
- Fixed task kill handling so the app no longer reports a false success when the target daemon is offline or cannot accept the request.

### Removed

- _None._

### Security

- _None._

### Commits

- `8be52df` update claw/rfc
- `b4af3f2` add task restart flow
- `2c38953` update task restart flow
- `df3c40e` use ai-bridge package
- `9dccc71` refine restart popup
- `60c0a09` fix fire task restart daemon binding
- `0fb4f2d` update task restart and kill flow
- `5e9a8ad` refine task kill and branch action
- `5bd1e5e` adjust task branch icon
- `56ce873` tune task branch icon

---

## [0.2.28] - 2026-03-23

### Added

- Added a self-host bootstrap login flow so operators can create or reuse the first phone-based account, issue an API token, and open a one-time login URL without configuring SMS first.
- Added self-hosting docs for the minimal production setup and first-login bootstrap flow.

### Changed

- Improved self-host bootstrap and Prisma tooling so production-oriented commands load the expected app environment files more reliably.

### Fixed

- Fixed Linux installer behavior that could previously target a system npm prefix instead of a safer Conductor-owned local prefix.
- Fixed `node-pty` verification by restoring execute permission on the bundled `spawn-helper` before validation runs.

### Removed

- _None._

### Security

- _None._

### Commits

- `56ddde9` add self-host bootstrap login
- `8b9267f` add bootstrap env tests
- `300ec5e` fix node-pty verify permissions
- `c690738` fix install script local npm prefix

---

## [0.2.27] - 2026-03-23

### Added

- Added keyboard prompt history in the desktop task chat composer, including automatic focus for split-pane chat and local recall of the five most recent prompts with arrow keys.

### Changed

- Improved desktop task switching with faster detail rendering, animated task-card reordering when active conversations move to the top, and a task list idle surface that better matches the app background.
- Improved chat composition guidance with rotating prompt suggestions and smoother desktop split-pane input activation.
- Improved chat history loading so the web app opens long conversations from the latest page first and can continue loading older messages incrementally.
- Refined agent list freshness so desktop daemon/task surfaces refresh automatically when backend state changes.

### Fixed

- Fixed desktop task switching latency caused by redundant task-detail and message-history loading.
- Fixed chat history recovery after websocket reconnects so already-opened tasks refresh missed messages instead of staying stale.
- Fixed `/api/tasks/[taskId]/messages` compatibility so mixed-version web and CLI clients still receive the expected default history payload.

### Removed

- _None._

### Security

- _None._

### Commits

- `761b04f` update
- `6f635a5` update AGENTS.md
- `7c8cd58` refresh daemon list automatically
- `76b37c9` improve desktop task chat flow

---

## [0.2.26] - 2026-03-23

### Added

- Added Kimi CLI runtime support so operators can start and resume Kimi-backed Conductor sessions from the CLI and supported app surfaces.
- Added a desktop split-pane task workspace so larger screens can keep the task list and task detail open side by side.

### Changed

- Improved PTY task reentry to replay terminal state more smoothly after reconnects and session resume.
- Improved server-side PTY task diagnostics so task logs preserve more useful runtime detail during troubleshooting.
- Updated `conductor-config` backend suggestions to better guide Opencode setup.

### Fixed

- Fixed desktop task/detail selection sync so navigation and live updates keep the correct task open in the detail pane.
- Fixed PTY resume and transport edge cases that could leave terminal sessions stale or incomplete after reconnection.

### Removed

- _None._

### Security

- _None._

### Commits

- `9307726` add stays_running issue and update conductor-config for installing opencode as suggestions
- `e5ca6d4` update pty task log in server
- `d099365` improve pty reentry resume
- `b60e2f1` update desktop task split pane
- `a3783e4` Merge branch 'feat/pty-reentry-snapshot'
- `e25ac03` add kimi cli support
- `98d142f` merge kimi cli support
- `4788f84` update claw/issues
- `fc0cb59` Merge branch 'main' of github-dang217:lovemoon-ai/conductor

---

## [0.2.25] - 2026-03-22

### Added

- Added direct GitHub shortcuts to the landing page header and mobile actions menu so users can jump from the product site to the repository faster.

### Changed

- Improved PTY task runtime details with a terminal-friendly dark popover so connection diagnostics stay readable on terminal task pages.
- Reworked the one-line installer to manage a Conductor-owned Node runtime more reliably, show resolved install paths, and offer safer shell PATH setup guidance.

### Fixed

- Restored the `Runtime Details` panel on PTY task pages so terminal sessions can inspect their runtime state again.
- Fixed false `node-pty` verification failures during CLI installation when the probe hit benign `read EIO` errors.

### Removed

- _None._

### Security

- _None._

### Commits

- `8b4ef52` update readme
- `f5fa6a8` update landing and runtime details
- `ea600a8` update web/public/install.sh

---

## [0.2.23] - 2026-03-20

### Added

- Added tmux-style terminal shortcuts in the terminal toolbar so power users can drive common terminal actions faster.

### Changed

- _None._

### Fixed

- _None._

### Removed

- _None._

### Security

- _None._

### Commits

- `aeddc03` add tmux terminal shortcuts

---

## [0.2.22] - 2026-03-19

### Added

- Added Codex app-server resume handling that restores the requested working directory, so resumed `conductor fire` sessions reopen in the expected workspace.

### Changed

- Refined task chat copy interactions to avoid accidental long-press copies while keeping explicit copy actions available.
- Updated runtime status copy in the task chat so active AI SDK sessions surface clearer progress information.
- Clarified the operator release SOP for shipping npm packages and deploying production.

### Fixed

- Fixed Codex resume flows that previously ignored the requested cwd when reconnecting through the app-server transport.
- Fixed task chat runtime-status visibility regressions introduced by the refreshed message bubble experience.

### Removed

- _None._

### Security

- _None._

### Commits

- `8f1608e` update sop/06_release.md
- `fa3aa97` refine chat copy and runtime status
- `aebed0f` fix codex resume cwd handling

---

## [0.2.21] - 2026-03-19

### Added

- Added a refreshed app shell with dashboard-style sidebar navigation, richer help tips, inline notices, section cards, and toast feedback across the web app.
- Added task list list/grid views, upgraded task cards, and a more polished create-task dialog flow.
- Added CLI update notification plus daemon auto-update and version-check support.

### Changed

- Refreshed the landing page, docs surfaces, settings, projects, subscription, privacy, and terms pages for stronger product/brand consistency.
- Improved task detail chat, terminal, message bubbles, and mobile shortcuts to better support day-to-day session work.
- Updated issue tracking and RFC docs to reflect the frontend design refresh rollout.

### Fixed

- Fixed task and agent API/UI integration gaps surfaced by the refreshed tasks experience.
- Fixed release-blocking test coverage for task diagnostics, PTY fallback behavior, and streamed CLI worker output.

### Removed

- _None._

### Security

- _None._

### Commits

- `03ae3a6` update docs
- `03e5001` add frontend design rfc issues
- `d3e0e21` update sidebar
- `5325554` add daemon auto update and cli version checks
- `14ca834` polish tasks ui
- `ae8c34c` update terminal mobile shortcuts
- `1512de6` update task ui
- `e1971fa` update web/.env.example
- `1265692` update ui
- `a908d61` update helptip
- `08d1d8f` update docs
- `723328b` update issues status
- `463c768` update Sidebar.tsx
- `d8fb7c8` fix release tests

---

## [0.2.20] - 2026-03-18

### Added

- Added Feishu channel support across the web app and CLI, including binding, config, webhook, and outbox flows.

### Changed

- Improved PTY direct transport, diagnostics, terminal handling, and relay/gateway behavior for interactive sessions.
- Added a websocket watchdog for `conductor fire` to recover stale connections more reliably.
- Renamed the production deployment script to `scripts/deploy-prod.sh` and updated related SOP/install references.
- Updated CLI config handling and refreshed dependency lockfiles.

### Fixed

- Added the missing PTY task type database migration.
- Improved `node-pty` installation handling in both `install-cli.sh` and `web/public/install.sh`.
- Fixed Feishu channel delivery and group mention flow issues.
- Guarded PTY writer handoff revocation to fix the production web build during release.

### Removed

- Removed the legacy `web/public/install.cmd` artifact.

### Security

- _None._

### Commits

- `aef5ac0` add feishu P0/P1
- `5503184` fix: add missing task type pty migration
- `77bfb87` update node-pty issus in install-cli
- `f001251` update node-pty issus in install.sh
- `0240a83` add fire ws watchdog
- `82538cc` rename start_prod.sh to deploy-prod.sh
- `52f537e` fix feishu channel flow
- `153dab1` update conductor-config.js
- `304d095` improve pty direct transport
- `d622756` update pnpm-lock.yaml
- `92c1558` fix app gateway build

---

## Release Entry Template

> Copy this template for each new version and place it below `Unreleased`.

```md
## [x.y.z] - YYYY-MM-DD

### Added

- New features.

### Changed

- Behavior changes, refactors, or internal improvements.

### Fixed

- Bug fixes.

### Removed

- Removed features or deprecated items.

### Security

- Security-related fixes.

### Commits

- `abc1234` short commit message
- `def5678` another commit message
```

---

## Changelog Rules

1. Add all unreleased changes to `## [Unreleased]` first.
2. When releasing a new version:
   - Rename `Unreleased` changes into `## [x.y.z] - YYYY-MM-DD`
   - Keep change types under `Added`, `Changed`, `Fixed`, `Removed`, `Security`
   - Add a `Commits` section with the included commit SHA and subject
3. Start a fresh empty `## [Unreleased]` section at the top after each release.
4. Do not mix unrelated changes across versions.
5. Prefer concise, user-facing descriptions instead of implementation detail.

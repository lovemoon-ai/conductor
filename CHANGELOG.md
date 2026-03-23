# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
with an additional `Commits` section for each released version.
This project follows [Semantic Versioning](https://semver.org/) where practical.

## [Unreleased]

### Added

### Changed

### Fixed

### Removed

### Security

### Commits

- _None yet_

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

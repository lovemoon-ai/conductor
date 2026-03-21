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

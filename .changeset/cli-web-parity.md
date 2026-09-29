---
"@love-moon/conductor-cli": minor
"@love-moon/conductor-sdk": patch
---

The CLI can now do what the web app can:

- `conductor task`: `stop`, `interrupt`, `restart`, `delete`, `archive`/`unarchive`,
  `rename`, `pin`/`unpin`, `move`, `labels`, `share`/`unshare`, `persistent`,
  `round start|end`, `cleanup-worktree`, `terminal open|show|close`, `resume`,
  `attachment download`, and `schedule update`. `create` also takes `--daemon-host`, `--agent` (multi-agent group),
  `--global-backend`, `--worktree`, `--remote-worktree` and `--persistent`.
  `send --attach` uploads files, `messages --follow` streams new messages, and
  `list --all-projects` / `--project-ids` lists tasks across projects.
- `conductor project`: `update`, `refresh`, `delete`, `reorder`, `agents`,
  `collab invite|show-invite|join|leave`, `labels list|add|rename|remove`.
- `conductor issue`: `delete`, and `list --all-projects` / `--project-ids`.
- `conductor daemon`: `restart`, `upgrade [--status|--wait]`, `sessions`, `accounts`,
  `switch-account`, `commands list|run|status`, `share create|list|revoke|show-invite|accept`.
- New `conductor search`, `conductor settings` (global backends, catchphrases, daily
  report, task-list and card-group preferences, generated reports) and `conductor auth`
  (`whoami`, `tokens list|create|revoke`).

Fix: `conductor project hide/unhide` (and the SDK's `setProjectHidden`) no longer erase
the project's metadata (task labels, memos, binding data).

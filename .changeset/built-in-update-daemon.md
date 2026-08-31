---
"@love-moon/conductor-cli": minor
---

Add a built-in "Update daemon" action to the web settings Danger zone.

This replaces the hand-rolled `update` custom command people were keeping in
`custom_commands` (upgrade the CLI, then restart the daemon in tmux) with a
first-class button on any daemon advertising the new `update_daemon` capability.

The update is designed so that a failure never leaves the machine without a
daemon:

- It runs in a **detached** updater process, not inside the daemon, so the
  daemon it replaces can exit without taking the update with it — and a
  crashing update cannot take the daemon down either.
- Install and verification happen **first**. The running daemon is only stopped
  once the new version is installed, reports the expected version, and passes
  the node-pty native check. Anything failing before that aborts with the old
  daemon still running and still serving tasks.
- A half-removed global install (the `ENOTEMPTY` case) is uninstalled, its
  package directory removed, and the install retried once.
- Progress is journaled to `~/.conductor/state/daemon-update.json` (full output
  in `~/.conductor/logs/daemon-update.log`), so the outcome survives the restart
  and the web UI can poll for it across the daemon's reconnect.

Homebrew installs, non-global installs, and shared guest daemons refuse the
action up front with the reason shown in the UI.

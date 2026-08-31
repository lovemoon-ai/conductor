---
"@love-moon/conductor-cli": minor
---

Add daemon sharing so a host can invite other conductor accounts to run tasks on their machine.

A host daemon can create share invitations from the web settings page. Each invite is scoped to one guest user and carries a `allow_cli_list` whitelist. When the guest accepts, the host daemon spawns an isolated guest daemon with a dedicated workspace and token; the guest sees only their own tasks and cannot access the host's projects or files outside the shared workspace.

Guest daemons are supervised by the host daemon: if the host restarts, guest configs are regenerated from the backend on the next reconcile; revoking a share stops the guest daemon and removes its workspace.

This changes the agent-token schema (a new `scope` column is required on the backend) and adds `conductor_guest`, `allow_cli_list`, and `daemon_name` handling to the guest config path.

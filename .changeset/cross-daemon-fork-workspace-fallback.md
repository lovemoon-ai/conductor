---
"@love-moon/conductor-cli": patch
---

Fix "New task from this" when the successor runs on a different daemon.

Picking another daemon in the dialog created the successor row and then killed
it one second later with `new task failed: Could not resolve resume cwd`. The
server intentionally drops the source machine's paths for a cross-daemon fork,
and the target daemon had nothing left to resolve: no launch-config `cwd`, no
worktree, no local project path (the default project has none, and a project
bound to another daemon is refused by design), and no source session in its own
session store.

Fork modes now fall back to a fresh `<workspace>/<date>/<run>` directory — the
same fallback `create_task` already uses — so the successor starts like a
brand-new task on that machine and picks up the conversation through the
resume-context URL. In-place restarts still fail loudly, because they must reuse
the original working directory.

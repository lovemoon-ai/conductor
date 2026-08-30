---
"@love-moon/conductor-cli": patch
---

Keep every task in a multi-agent group in one working directory. Creating a
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

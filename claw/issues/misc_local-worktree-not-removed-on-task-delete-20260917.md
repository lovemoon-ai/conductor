# misc: deleting a task with a local worktree leaves `.conductor/worktrees/<branch>` on disk

- Date: 2026-09-17 (found during the v0.13.0..278f970 release QA round)
- Severity: P2. It leaks clean worktree directories on disk; the task deletes normally and no user data is lost.
- Status: **pre-existing, not a regression of this delta.** It reproduces on a pure v0.13.0 stack (web `e1e507f` + CLI 0.13.0).
- Layer: execution / cleanup (task delete → daemon worktree teardown)

## Symptom
`claw/lessons/misc_worktree_delete_outbox_cleanup_20260408.md` says deleting a worktree-backed task queues `cleanup_task_worktree` in the durable agent outbox and the daemon tears the worktree down.

In every run the task was deleted (`DELETE 204`, diagnose `snapshot`), but `<repo>/.conductor/worktrees/<branch>` and `<branch>.ready` were still on disk 30–40 s later (and still later, for the C10 tasks). No cleanup line appeared in the daemon log.

| stack | daemon mode | flow | worktree after delete |
|---|---|---|---|
| web 278f970 + CLI 278f970 (`qa-dev-daemon`) | tmux | UI stop → UI delete | `feee5f` kept |
| web 278f970 + CLI 278f970 (`qa-dev-daemon-b`) | direct spawn | UI stop → UI delete | `ddffef` kept |
| web 278f970 + CLI 278f970 (`qa-dev-daemon-b`) | direct spawn | UI delete while running | `be68fa` kept |
| web 278f970 + CLI 0.13.0 (`qa-old-daemon`) | direct spawn | UI stop → UI delete | `d21a5f` kept |
| **web v0.13.0 + CLI 0.13.0** (`qa-web013-daemon`, :6155) | direct spawn | API delete while running | `383311` kept |
| C10 issue tasks (agent run) | tmux | API stop → delete | `242ddb`, `4d2292`, `848bd3` kept |

By contrast, remote worktrees (RFC 0038) **are** removed on delete within ~2.5 s (case C11).

## Expected
Per the lesson, the worktree is removed by the daemon shortly after delete, and the branch may stay.

## Reproduction
1. New task on a git-backed project with **worktree** ticked in Advanced options; wait for the reply.
2. Delete the task (with or without Stop first).
3. `ls <project>/.conductor/worktrees/`: the branch directory is still there.

## Evidence
`claw/issues/tmp_release-qa-20260917/tmp_evidence/`:
- `wt-a-*`, `wt-b-*`, `wt-b2-deleted-running.*`, `wt-old-*` (screenshots, console/network logs, diagnose JSON)
- `wt-baseline-v013.txt`

## Suspected component
Delete-path enqueue of `cleanup_task_worktree` in `web/src/app/api/tasks/[taskId]/route.ts`, or the daemon handler for that command. Confirm with the developer whether cleanup is intentionally skipped for single-owner worktrees before fixing.

## Note for the fixer
This is a user-visible product bug. Per `CLAUDE.md`, add a lesson under `claw/lessons/` with the fix.

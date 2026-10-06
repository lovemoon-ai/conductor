# File preview asks the AI's daemon, not the code's, on a global-backend task

## Symptom
On task 507ac1ca (Codex on global backend `macmini`, project `real2sim` on
`apex`), clicking a link like `/mnt/data1/min.du/ws/real2sim/.../STATUS.md` in an
AI reply failed with "no such file on macmini". The file exists on `apex`.

## Root cause
The preview route picked the daemon with
`resolveFireTaskRouting(task).daemonAssociationHost`, which returns "the daemon
that runs the task". On an ordinary task that daemon also holds the files.
A global-backend task (RFC 0041) is filed under a project bound to the AI
daemon, but the AI reads and writes the user's project on another daemon over
`conductor remote`. That host is recorded only in
`launchConfig.remoteWorkspace` / `remoteWorktree`, so the route asked the wrong
machine. Relative links were wrong for the same reason: the AI daemon resolved
them against its own cwd, not the remote workspace.

## Fix
`POST /api/tasks/[taskId]/preview` builds a list of candidate daemons and stats
the file on each in turn:
1. The remote workspace/worktree host, with relative paths joined to that
   workspace (or to `<workspace>/.conductor/worktrees/<branch>`).
2. The AI's own daemon, which covers scratch files it wrote locally.

The first daemon where the file exists serves the preview. If none has it, the
route returns the first daemon's error.

## How to avoid next time
"Which daemon runs this task" and "which daemon holds this task's files" are
two different questions since RFC 0041. Any feature that touches a task's files
(preview, diff, file browser, remote cp) has to check
`parseRemoteWorkspaceLaunchConfig` / `parseRemoteWorktreeLaunchConfig`, not just
the routing host. Test with a task whose launch config points at another host.

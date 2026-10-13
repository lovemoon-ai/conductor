# Task terminal opens on the AI's daemon, not the code's, on a global-backend task

## Symptom
On a task whose AI runs on a global backend (say Claude on `macmini`) while
the project lives on another daemon (`apex`), the task's terminal button
opened a shell on `macmini`, in the AI's read-only clone or the default
project directory. The user wanted a shell where the code is: on `apex`, in
the project directory or the task's remote worktree.

## Root cause
`POST /api/tasks/[taskId]/terminal` chose the host with
`resolveAttachedTerminalAgentHost`, which prefers `task.agentHost` and then
`project.daemonHost`. On a global-backend task (RFC 0041) both name the AI's
daemon: the task is filed on a project bound to that daemon on purpose, so
that every router can rely on `agentHost = project.daemonHost`. The code's
daemon is recorded only in `launchConfig.remoteWorkspace` /
`launchConfig.remoteWorktree`, and the terminal never read it. The cwd came from
the same AI-side sources (`metadata.cwd`, `launch_config.cwd`, the project's
workspacePath).

The preview route had the same bug and was fixed on 2026-10-06
(`arch_preview-global-backend-wrong-daemon-20261006.md`). That fix also joined
relative paths to the worktree root rather than the AI's work dir, which
differs when the project is a subdirectory of its repository.

## Fix
- New `resolveTaskRemoteCodeLocation(launchConfig)` in
  `lib/tasks/remote-worktree.ts` returns `{ host, workDir, projectDir }` for a
  remote worktree or workspace. It uses the same path math as the operating
  protocol given to the AI (`resolveRemoteWorktreePaths`). If a malformed
  row's workspace is outside its repoRoot, it falls back to the worktree root
  instead of throwing.
- `resolveAttachedTerminalAgentHost` sends the terminal to that host when it
  exists. If the code's daemon is offline or cannot run terminals, it returns
  a 409 that names the daemon and says what to do (start the daemon, or
  upgrade it / enable terminals). It does not quietly open a shell on the
  AI's machine.
- The terminal's cwd is mkdir'd by the daemon. A remote worktree exists only
  after the AI runs `git worktree add`, and creating its directory first (or a
  subdirectory inside it) makes that step fail with "already exists". So
  `resolveAttachedTerminalCodeCwd` stats the worktree's work dir on the code's
  daemon (5 s timeout) and uses it only if it is there. If the worktree is
  missing, or the daemon cannot stat or the stat fails, the terminal starts in
  the project directory, which always exists.
- The preview route uses the same helper, so its relative links resolve
  against the real work dir.

The PTY task stays filed on the AI task's project (attached terminals are
hidden from the list by that project id). Only its `agentHost` differs, and
PTY routing, ownership checks and stop all key on `agentHost`.

## Review of other task features (same question: AI daemon or code daemon?)
- Stop / interrupt / insert / messages / runtime-status / scheduled messages /
  diagnostics: these act on the AI process, so they correctly use the AI's daemon.
- Worktree delete, task delete/archive and project delete clean up the
  remote worktree on its own daemon (`resolveTaskWorktreeCleanupPlan`). Correct.
- Restart / "New task from this" / in-place restart keep the remote binding
  (`isGlobalBackendAgentHost`, `resolveCrossDaemonRemoteBinding`). Correct.
- The task card's daemon chip and the daemon filter (`resolveTaskDaemonHost`)
  show the code's daemon for a global-backend task. Correct.
- File preview: fixed earlier; now shares the helper.
- Terminal: this fix.

## How to avoid next time
Since RFC 0041, "which daemon runs this task" and "which daemon holds this
task's files" are separate questions. Anything that touches a task's files or
working directory must call `resolveTaskRemoteCodeLocation` first and fall back
to the routing host only when it returns null. Test with a task whose launch
config has a `remoteWorkspace` / `remoteWorktree` on another host.

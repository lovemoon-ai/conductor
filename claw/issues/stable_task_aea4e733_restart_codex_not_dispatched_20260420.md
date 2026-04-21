# stable: task aea4e733 codex in-place restart rejected by active child (2026-04-20)

## Correction

The earlier diagnosis confused a branch/new-task operation with restart.

Successor task `f1ee1db7-5023-4501-b893-a341faca5dac` was created through `fork_to_new_task -> claude`. That was a branch/new task from `aea4e733-d9a0-4627-af56-a2316fcc55df`, not the in-place restart reported by the user.

The restart case to diagnose is: source task `aea4e733-d9a0-4627-af56-a2316fcc55df`, killed, restarting with the same `codex` backend.

## Symptom

Online task `aea4e733-d9a0-4627-af56-a2316fcc55df` was reported as unable to restart after being killed.

## Source Task State

The task was diagnosed live, not from a snapshot.

- Source task: `aea4e733-d9a0-4627-af56-a2316fcc55df`
- Source status: `killed`
- Source backend: `codex`
- Source session id: `300a40b5-8104-4c2f-b85f-b0c7a03338d3`
- Source daemon: `m1`
- Realtime binding: `m1`
- `m1` was online and advertised support for `codex`

These fields satisfy the restart route's basic requirements for same-backend in-place restart.

## Root Cause

The source task was marked `killed` in the production database, but the original daemon child process was still alive on `m1`.

Local `m1` process evidence:

```text
56852 23410 Sun Apr 19 10:03:50 2026 /Users/duino/.nvm/versions/node/v23.11.0/bin/node /Users/duino/ws/conductor/cli/bin/conductor-fire.js --backend codex --resume 300a40b5-8104-4c2f-b85f-b0c7a03338d3 --
```

`300a40b5-8104-4c2f-b85f-b0c7a03338d3` is the session id of task `aea4e733-d9a0-4627-af56-a2316fcc55df`.

The production `agent_outbox` rows show repeated in-place restart commands for the task. They were delivered to `m1`, but daemon rejected them:

```text
eventType=restart_task status=acked lastError=nack:restart_task agentHost=m1
mode=resume_inplace source=aea4e733 target=aea4e733 sourceBackend=codex targetBackend=codex
```

The restart payload itself was valid. In the daemon code, the remaining matching early rejection path is the active-target guard:

```text
task already active
```

So the immediate root cause is a split-brain state:

- DB/UI state: task is `killed`.
- Daemon/process state: the original codex fire process for the same task/session is still active.

Because of that mismatch, every in-place restart is rejected before the daemon starts a new codex resume.

## Why DB Killed Can Diverge From The Process

The UI does not kill the daemon process directly. It sends a task update with `status: killed`.

The server route then decides whether this status update should also enqueue a daemon `stop_task` command:

```text
shouldStopTask = nextStatus === "killed" && existingStatus in ["running", "unknown"]
```

So `stop_task` is only sent when the server-side DB row is still `running` or `unknown` at the moment the PATCH is handled. If the DB row is already terminal, the server treats `status: killed` as a status update and does not send a process stop command.

There are also other paths that can write terminal state (`killed`) without proving that the original OS child has exited, such as daemon restart failure reporting, stale recovery, or terminal status updates. That makes `task.status` a UI/backend state field, not a guaranteed process-liveness invariant.

For this task, production `agent_outbox` confirms the divergence:

```text
task aea4e733 outbox event types:
restart_task: 11
task_user_message: 11
stop_task: 0
```

No durable `stop_task` was recorded for the task, while the old process was still alive on `m1`. Therefore the process was never actually stopped through the normal durable stop path before restart attempts began.

## Expected Daemon Evidence

If the codex in-place restart reached the daemon, the daemon should log a line shaped like:

```text
Restarting task aea4e733-d9a0-4627-af56-a2316fcc55df from aea4e733-d9a0-4627-af56-a2316fcc55df (resume_inplace -> codex)
```

That line was not found in the available daemon or worktree logs after the task was killed because the daemon rejected the command before reaching the spawn/logging path.

The only `aea4e733` restart line found was the original creation from parent task `101d04b3-842f-404c-bc3e-1e0b9049059e`:

```text
[conductor-daemon 2026-04-19T10:03:50] Restarting task aea4e733-d9a0-4627-af56-a2316fcc55df from 101d04b3-842f-404c-bc3e-1e0b9049059e (fork_to_new_task -> codex)
```

The separate branch/new-task operation was:

```text
[conductor-daemon 2026-04-20T20:45:13] Restarting task f1ee1db7-5023-4501-b893-a341faca5dac from aea4e733-d9a0-4627-af56-a2316fcc55df (fork_to_new_task -> claude)
```

That branch task later failed in the `claude` runtime, but it is not evidence for the codex restart failure.

## Current Conclusion

The codex restart failure was not a codex runtime failure. It was a state synchronization bug between task status and daemon process lifecycle.

The task became `killed` in DB without terminating the old daemon child process. The UI then offered restart, the API correctly produced `resume_inplace -> codex` outbox commands, and daemon `m1` correctly refused to start a second child for the same task.

The diagnostics output was initially misleading because it does not expose raw `agent_outbox` command rows such as `restart_task`; it only exposes user-message outbox summaries.

## Evidence

Commands used:

```bash
conductor diagnose aea4e733-d9a0-4627-af56-a2316fcc55df
conductor diagnose aea4e733-d9a0-4627-af56-a2316fcc55df --json
conductor diagnose f1ee1db7-5023-4501-b893-a341faca5dac --json
rg -n "Restarting task aea4e733|aea4e733-d9a0-4627-af56-a2316fcc55df.*resume_inplace|resume_inplace -> codex|restart_task" ~/.conductor/logs/conductor-daemon.log .conductor/worktrees/101d04b3-842f-404c-bc3e-1e0b9049059e/conductor.log
ps -eo pid,ppid,lstart,command | rg 'aea4e733|300a40b5|101d04b3|conductor fire|conductor/bin/conductor|cli/bin/conductor'
```

Relevant local log path:

```text
/Users/duino/.conductor/logs/conductor-daemon.log
```

Relevant worktree log path:

```text
/Users/duino/ws/conductor/.conductor/worktrees/101d04b3-842f-404c-bc3e-1e0b9049059e/conductor.log
```

## Follow-up

1. Fix the kill path so marking an `ai_task` as `killed` cannot leave the daemon child running.
2. For restart, if a stopped task still has an active daemon child, either stop-and-wait first or return a visible error that the old process is still active.
3. Make daemon `reportRestartFailure` log the rejection reason locally and include it in a durable status event.
4. Extend task diagnostics to include recent non-message outbox commands, especially `restart_task`, with status, retry count, ack time, and last error.

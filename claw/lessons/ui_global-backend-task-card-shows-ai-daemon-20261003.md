# Global-AI task card shows the AI daemon instead of the workspace daemon

## Symptom
Task `59e7fc9d` ("Team·Lead") runs in global AI mode: the AI (claude) runs on
`macmini`, the code is the `real2sim` project on `apex`. The task card showed
`real2sim · macmini`. Both daemons have a project called `real2sim`, so the card
pointed at the wrong workspace.

## Root cause
The card's daemon chip, the daemon filter and the task-detail navigation all use
`resolveTaskDaemonHost`. It checks `metadata.daemonName`, then `executionHost`,
then `agentHost`. For a global-backend task (RFC 0041), all three name the
**AI** daemon. The workspace host is stored only in
`launchConfig.remoteWorkspace.host` / `launchConfig.remoteWorktree.host`, and
the resolver never read it. The project chip was already right, because
`secondProjectId` is the display project. The daemon chip was not.

## Fix
`resolveTaskDaemonHost` now returns the remote workspace/worktree host first
for tasks that have `metadata.globalBackend`. The AI daemon stays visible in the
backend chip's hover hint (`AI on macmini (claude)`).

## Avoid next time
When a feature splits "where the AI runs" from "where the code lives", check
every display resolver that reads `agentHost` / `executionHost` /
`daemonName`. They answer "where the AI runs", not "which workspace".

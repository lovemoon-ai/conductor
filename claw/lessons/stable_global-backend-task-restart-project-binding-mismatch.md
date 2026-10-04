# Global-backend task cannot restart: "Task daemon X does not match project binding Y"

## Symptom
Task `013bca54` ("复现 Flow Reversal Steering (FRS) 论文") ran its AI on ruofo
(claude-opus, a global AI backend). Its code is in project `frs-repro`, which
is bound to apex. After the task was killed, every restart failed with
`409: Task daemon ruofo does not match project binding apex`.

## Root cause
The task came from "New task from this" with an `agent_host` override
(claude on apex → claude-opus on ruofo). For a cross-daemon successor, the
restart route keeps the source `projectId` (bound to apex). It sets
`agentHost = ruofo`, `metadata.globalBackend = {host: ruofo}`, and
`launchConfig.remoteWorkspace = {host: apex, ...}`. This is a valid RFC 0041
shape: the AI runs on ruofo and reaches apex through `conductor remote`.

A later restart without an override forces the AI back onto the project's
daemon. Both `restart/route.ts` and `lib/tasks/inplace-restart.ts` reject any
non-fire task whose `agentHost` differs from `project.daemonHost`. Neither
checked for a global-backend task.

## Fix
`isGlobalBackendAgentHost(task, agentHost)` in `lib/tasks/global-backend.ts`
returns true when `metadata.globalBackend.host === agentHost` and the launch
config holds a remote worktree or remote workspace. When it is true, both
restart paths skip the project-daemon binding and restart on the task's own
AI daemon. The inherited `remoteWorkspace`/`remoteWorktree` still points the AI
at the code's daemon.

## How to avoid next time
Any path that enforces `agentHost == project.daemonHost` must also handle
global-backend tasks. The cross-daemon successor path creates such tasks
without re-filing them on a project bound to the AI daemon. Every flow that
creates a task shape (create, restart new_task, cross-daemon override) needs a
test that restarts the resulting task.

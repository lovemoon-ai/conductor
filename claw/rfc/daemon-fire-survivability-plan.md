# Daemon/Fire decoupling stability solution (draft)
## background
Currently `conductor-daemon` is responsible for starting `conductor-fire`. In the existing implementation, there is obvious life cycle coupling between `fire` and `daemon`:
- `daemon` starts `fire` through `stdio: ["inherit", "pipe", "pipe"]` and consumes the child process output in the parent process.- `fire` writes logs to `stdout/stderr` by default.- The task end status (`COMPLETED/FAILED`) is mainly reported by `daemon` in the `child.on("exit")` callback.
This leads to a key risk: if `daemon` crashes or is killed, `fire` may become unstable due to the disconnection of the IO pipe (such as `EPIPE`) or the influence of the parent process signal; at the same time, the task end status reporting link may also be interrupted.
## Target
- After `daemon` exits abnormally, the started `fire` should try to continue running stably.- Task status reporting does not depend on `daemon` for survival.- Keep the existing creation task and message processing main process unchanged.
## non-target
- This article does not cover strong guarantees such as "the process never exits" (which is still affected by system OOM, manual kill, and host failure).- This article does not include the details of the transformation of the service orchestration layer (systemd/supervisor/k8s).
## Plan Overview
### 1. Process group decoupling: `fire` runs in an independent session
When `daemon` starts `fire`:
- Use `detached: true` to create an independent process group.- Call `child.unref()` after startup to release the event loop reference relationship.
Effect: After `daemon` exits, `fire` will not end passively due to the parent-child process reference relationship.
### 2. IO decoupling: no longer transfer logs through `daemon` pipe
Replace `pipe` log link for `daemon -> fire`:
- `child.stdout.pipe(...)` / `child.stderr.pipe(...)` are no longer used.- Directly redirect `fire`'s `stdout/stderr` to the task log file (or `ignore`).
suggestion:
- `stdio: ["ignore", outFd, errFd]`, where `outFd/errFd` points to the task-level log file.- `daemon` only records control plane logs such as "fire(pid) started" and does not consume long stream output.
Effect: After `daemon` crashes, `fire` will not cause an exception due to the pipe disconnection of the parent process.
### 3. Status reporting sinking: `fire` reports the task end status by himself
Move the task final status responsibility from `daemon` to `fire`:
- `fire` is responsible for reporting to `RUNNING` after startup (the daemon startup status report can be retained for compatibility).- `fire` reports in the main process `finally` / exit processing:- Normal exit -> `COMPLETED`- Abnormal exit -> `FAILED` + summary
Implementation suggestions:
- Added the `update_task_status` tool to the SDK MCP capability, and internally uses the existing websocket `task_status_update` event path.- `conductor-fire` reports status through `ConductorClient.callTool("update_task_status", ...)`.
Effect: Even if `daemon` has lost contact, `fire` can still independently complete the task status closed loop.
### 4. Fault tolerance: `fire` log writing exception protection
Add lightweight defense to `fire`:
- Register `error` event handling for `process.stdout` / `process.stderr` (ignore or downgrade).- When the log function `log()` fails, it does not affect the main logic (captures log writing exceptions).
Effect: Reduce the impact of log channel exceptions on the main business loop.
### 5. Observability enhancement (suggestion)
- Record `fire_pid` to task metadata (easy for troubleshooting).- Optional addition of `fire` heartbeat (for example, sending alive signal every 30s), and the backend displays "offline/suspected to be stuck" based on TTL.
## Phased implementation suggestions
### Phase 1 (minimum available)
- `daemon` side completed `detached + unref + stdio file redirection`.- Remove `daemon`'s dependency on `child.on("exit")` for final status reporting.
### Phase 2 (state closed loop)
- SDK MCP adds `update_task_status` tool.- `fire` adds `RUNNING/COMPLETED/FAILED` reporting logic.
### Phase 3 (enhanced steady state)
- Added heartbeat and TTL observability.- Added more fine-grained exit reason classification (user termination/system signal/running error).
## Verification list
### Function verification
- After creating the task, `fire` started successfully and can send and receive messages normally.- After artificially killing `daemon`, `fire` still continues to process new messages.- After `fire` ends, the task status correctly falls to `COMPLETED` or `FAILED`.
### Fault verification
- Simulation log file not writable: `fire` should not crash immediately.- Simulate websocket short-term disconnection: `fire` can recover and continue to report status.
### Regression verification
- Does not affect existing `--force`, lock file, `clean-all` behavior.- No changes to the task directory and log file naming convention (except for new fields).
## Risks and Precautions
- Post-`detached` child process recycling and zombie process management need to be confirmed (the current Node behavior is usually controllable, but needs to be verified on the target OS).- Duplicate status events may occur during the migration of status reporting responsibilities, which require idempotent processing (the backend deduplicates according to the task state machine).- It is necessary to ensure that `fire` gets enough authentication context (`CONDUCTOR_AGENT_TOKEN`, backend address) to report independently.
## Rollback strategy
If an exception occurs after going online, you can press the switch to roll back:
- Fallback to old `daemon` pipe mode.- Temporarily resume `child.on("exit")` status reporting of `daemon`.- Keep `fire` to add reporting logic but perform priority control on the backend to avoid double-write conflicts.
## state
- Document status:Draft- Update time: 2026-02-07
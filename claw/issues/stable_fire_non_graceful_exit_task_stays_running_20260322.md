# stable: fire non-graceful exit leaves task stuck in running (2026-03-22)

## Scope
- Task: `65a4cad7-6fbb-4db1-80fc-27c1f4659732`
- Project: `6c83cfa0-077b-4a4f-8333-4f3163e07f0c`
- Title: `123`
- Configured host: `mlx`
- Execution host: `conductor-fire-mlxlabfkpjgdbu69be67c2-20260321094122-se5w4c-master-48725`

## Evidence Sources
- `conductor diagnose 65a4cad7-6fbb-4db1-80fc-27c1f4659732`
- `conductor diagnose 65a4cad7-6fbb-4db1-80fc-27c1f4659732 --json`
- Fire final status reporting path: [cli/bin/conductor-fire.js](/Users/bytedance/ws/conductor/cli/bin/conductor-fire.js#L666)
- Fire finalization path: [cli/bin/conductor-fire.js](/Users/bytedance/ws/conductor/cli/bin/conductor-fire.js#L690)
- Task stale recovery path: [web/src/app/api/tasks/route.ts](/Users/bytedance/ws/conductor/web/src/app/api/tasks/route.ts#L376)
- Fire stale recovery timeout: [web/src/app/api/tasks/route.ts](/Users/bytedance/ws/conductor/web/src/app/api/tasks/route.ts#L73)
- Task list fetch options: [web/src/lib/conductor/stores/tasks.ts](/Users/bytedance/ws/conductor/web/src/lib/conductor/stores/tasks.ts#L96)
- Default list load path: [web/src/lib/conductor/stores/tasks.ts](/Users/bytedance/ws/conductor/web/src/lib/conductor/stores/tasks.ts#L186)
- Websocket bootstrap fetch path: [web/src/lib/conductor/hooks/useWebSocket.ts](/Users/bytedance/ws/conductor/web/src/lib/conductor/hooks/useWebSocket.ts#L13)
- Task detail load path: [web/src/app/app/tasks/[taskId]/page.tsx](/Users/bytedance/ws/conductor/web/src/app/app/tasks/[taskId]/page.tsx#L21)
- Task detail API path: [web/src/app/api/tasks/[taskId]/route.ts](/Users/bytedance/ws/conductor/web/src/app/api/tasks/[taskId]/route.ts#L362)
- Status persistence path: [web/src/lib/realtime/agent-upstream.ts](/Users/bytedance/ws/conductor/web/src/lib/realtime/agent-upstream.ts#L243)

## Conclusion
- The fire process was already offline, but the task row stayed at `status=running`.
- The last user message was queued to the dead fire execution host and never reached the worker.
- This is not a live execution still processing. It is a stale `running` task after a non-graceful fire exit.
- The immediate reason the task still showed `running` is:
  - `conductor fire` reports `RUNNING` on startup.
  - It only reports `KILLED` or `COMPLETED` when the process reaches the graceful finalization path.
  - A hard kill or other non-graceful exit bypasses that path.
  - Backend stale recovery exists, but it only runs when `GET /api/tasks?recover_stale=1` is called.
  - The default app list load and task detail load do not call that recovery path.

## Online Diagnosis Snapshot
- Diagnose time: `2026-03-21T18:58:40.151Z`
- Task status: `running`
- Bound agent host: `null`
- Assigned agent host: `conductor-fire-mlxlabfkpjgdbu69be67c2-20260321094122-se5w4c-master-48725`
- Assigned agent connected: `false`
- Assigned agent disconnect time: `2026-03-21T18:43:06.207Z`
- Fire logs: unavailable because daemon host `mlx` was offline during diagnosis

These fields show that the backend no longer considers the execution fire host online, but the task record still had not converged to a terminal status.

## User-Facing Failure Shape
- Latest sdk message:
  - id: `233b5204-cd5f-47e1-b270-f0412fc77725`
  - time: `2026-03-21T18:40:20.102Z`
  - preview: `2`
- Latest user message:
  - id: `89d8bb32-ff88-4cdc-98f5-54608f4b639c`
  - time: `2026-03-21T18:54:07.231Z`
  - content: `2+2=`
- Pending user: `true`
- Pending age at diagnosis: about `273s`
- Latest user outbox:
  - status: `pending`
  - attempt_count: `4`
  - last_error: `Agent offline`
  - sent_at: `null`
  - acked_at: `null`

This means the user sent a new message after the fire host had already dropped offline. The backend kept retrying delivery to that dead execution host, so the task looked alive but could not make forward progress.

## Code-Level Root Cause

### 1. Fire marks the task as running early
- `conductor fire` sends `RUNNING` after attaching to the task.
- This happens in the foreground fire flow before the main polling loop.

### 2. Fire only writes the final task status on graceful shutdown
- `KILLED` or `COMPLETED` is sent only in the `finally` block of the main fire flow.
- That path depends on the process reaching normal unwind, signal handling, or an in-process error path.
- A hard kill such as `kill -9`, or any non-graceful termination that bypasses process cleanup, will skip this report.

### 3. Runtime status does not repair task.status
- Task status persistence is handled by `task_status_update` commit flow.
- The runtime-status websocket path is for transient UI state and does not itself converge the task row to `killed` or `completed`.

### 4. Stale recovery exists, but is not on the default user path
- Backend stale recovery for disconnected fire tasks uses a default timeout of `30_000ms`.
- That recovery logic is only executed in task list GET when the request includes `recover_stale=1`.
- The normal app bootstrap path calls `fetchTasks()` without `recoverStale`.
- The task detail page calls `fetchTask(taskId)` and the detail API also does not run stale recovery.
- The manual refresh button on the tasks page is the visible path that does pass `recoverStale: true`.

## Why The Task Still Looked Running
- The task row was left behind in the last persisted state: `running`.
- No graceful fire final-status report arrived after the worker died.
- No default UI fetch path triggered stale recovery.
- As a result, the user could still open the task and send a message, but that message only accumulated in outbox retries against an offline fire host.

## Impact
- A fire task can remain visibly `running` long after the actual execution host is gone.
- New user messages may be accepted and queued, but they will never reach the dead worker.
- The UI can therefore present a false liveness signal: task looks active while delivery is already broken.

## Suggested Follow-Up
- Immediate operational recovery:
  - Trigger stale recovery for this task path or explicitly mark the task `killed`.
- Product fix direction:
  - Make the default task list or task detail path trigger stale recovery for clearly offline execution hosts.
  - Alternatively add a backend-side or fire-side janitor so stale fire tasks do not depend on a manual `recover_stale=1` list fetch.

## Confidence
- High confidence on the stale-running diagnosis.
- Medium confidence on the exact local kill mechanism, because the available online diagnose payload does not include the local fire exit reason or a fire log segment for this host.

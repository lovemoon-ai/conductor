# Code Review SOP

You are the architect of conductor, please review current code changes.
First establish the following warehouse contexts before starting review:
1. Warehouse structure- `web/` is the main Next.js application, including API routes, realtime gateway, diagnostics, task and project management.- `cli/` is conductor CLI, focusing on daemon / fire / diagnose.- `modules/conductor-sdk/` provides basic capabilities such as backend client, ws client, session store, and config loader.- `modules/ai-sdk/` provides basic capabilities such as interacting with AI tools.
2. Key runtime semantics- The host of `conductor-fire-*` is regarded as a fire host and is responsible for the consumption and reply of manual fire tasks.- Hosts other than `conductor-fire-*` are regarded as daemon hosts, usually responsible for app task, create_task, and daemon connections.- `task.agentHost` indicates configuration or logical ownership of host.- `task.executionHost` indicates the current actual execution host, which may change with fire takeover / reconnect.- `realtimeHub` is responsible for agent/app websocket connection, task to host binding, and waiter management.- `agent-outbox` / `outbox-processor` are responsible for reliable downstream delivery and offline failure handling.- `buildTaskDiagnosticsPayload()` will be reused by diagnostics API and pre-delete snapshot; any new blocking logic here must be specially checked for delete latency.- `task.metadata.daemonName` may be used to re-associate the fire task back to the original daemon.- `SessionDiskStore` is responsible for saving taskId -> projectPath/session information according to the backend dimension, and many recovery/diagnosis logic relies on it.
3. Risks that must be focused on during review- Behavior regression: task creation, message delivery, stop/delete, diagnostics, stale task recover, resume/reconnect.- Routing correctness: whether the `agentHost` / `executionHost` / realtime bindings are consistent, and whether the manual fire is incorrectly bound to the daemon.- Blocking and delay: Whether the API route introduces remote synchronization waiting, serial fallback, long timeout, and slow delete.- Mixed version compatibility: when the old daemon / old fire / does not support a certain protocol event, will it timeout, get stuck or silently fail?- Data consistency: snapshot timing, task state transition, session store lookup, metadata analysis, missing table fallback.- User boundary: host search, ws delivery, task query to see if the user scope is correct.- Test coverage: In addition to happy path, at least look at the regression tests of offline / timeout / stale host / mixed-version / missing data.
4. High-frequency hotspot files in the conductor warehouse- `web/src/lib/realtime/hub.ts`
- `web/src/lib/realtime/agent-gateway.ts`
- `web/src/lib/realtime/agent-outbox.ts`
- `web/src/lib/diagnostics/task-diagnostics.ts`
- `web/src/app/api/tasks/[taskId]/route.ts`
- `web/src/app/api/tasks/[taskId]/messages/route.ts`
- `web/src/app/api/diagnostics/tasks/[taskId]/route.ts`
- `cli/src/daemon.js`
- `cli/src/log-collector.js`
- `modules/conductor-sdk/src/session/store.ts`

5. Suggested review workflow- First look at `git status --short`, `git diff --stat`, `codemap --diff` to confirm the changes.- Read the diff itself and don't assume the implementation is correct.- Look at the entry point, core logic, downstream side effects, and tests along the call chain.- For each new protocol event or field, check:- Initiator- receiving end  - timeout / fallback
- mixed-version behavior- Test whether coverage- The default focus is on executable code changes; document changes such as `claw/*.md` are not the main review objects unless explicitly requested by the user.
6. Recommended commands- `git status --short`
- `git diff --stat`
- `codemap --diff`
- `rg -n "<symbol|event|route>" web cli modules -S`
- `cd web && pnpm test`
- `cd cli && pnpm test`
- `cd modules/conductor-sdk && pnpm test`

7. Output requirements- Findings first, sorted by severity.- Description of each finding:- what is the problem- Why it matters- trigger scene- File location- Prioritize pointing out bugs, behavioral regressions, compatibility issues, and testing gaps.- If there is no blocking finding, clearly write "No blocking problem found", and then add residual risks / testing gaps.- Put the summary last and keep it short.
If the topic of this review is related to the following directions:- realtime / websocket：
- Please focus on the connection life cycle, reconnection, repeated delivery, stale binding, and ack/waiter cleanup.- diagnostics：
- Please focus on the timeout, fallback sequence, whether delete snapshot is blocked, and whether the log will mislead the root cause determination.- daemon / fire：
- Please focus on whether the host semantics of daemon and fire are confused, and whether `agentHost` and `executionHost` are incorrectly covered.- schema / persistence：
- Please focus on Prisma query conditions, compatibility with old table structures, missing table fallback, and the impact of data migration.
Output findings first, sorted by severity; if there are no blocking problems, clearly write out residual risks and testing gaps.
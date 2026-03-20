# Production environment App side task disconnection problem: root cause solution and fault response manual

## 1. Problem classification (confirmed)

- Type A:`runTurn` stuck  
  The user message has been consumed by fire, but there is no `sdk_message` for a long time, and the log lasts `turn waiting ...`.
- Type B: Delivery link stuck after reconnection  
  The user message is successfully entered into the database, but does not enter the fire consumption link stably; it is often accompanied by websocket jitter, outbox `pending/sent` not `acked` for a long time, and task binding drift.
- Type C: Front-end status "blank misjudgment"  
  The message has been sent, but the runtime status has been cleared and there is no subsequent update. The user perceives it as "completely disconnected".
- Type D: PTY life cycle necrosis of local fire  
  A common sequence is `TUI process has exited` followed by `PTY session already spawned` for a long period of time, causing each user message to fail quickly and appear to be `no_pending_user`, but the task is actually unavailable.

---

## 2. Definition of "radical cure" (must be satisfied)

The "radical cure" here is not to make the model 100% error-free, but to eliminate "silent stuck, unrecoverable, unlocatable".

The following system invariants must be satisfied simultaneously:

1. Any user message must enter one of the final states within `30s`: `acked` or `failed(retriable/non-retriable)`.
2. Any turn must enter one of the final states within `N` minutes: `reply_ready` or `timeout_recovered` or `failed`.
3. The current stage (queuing/processing/recovering/failed) is always visible on the App side, and the status bar is not allowed to be blank.
4. Task only allows one "effective owner" (fire host + epoch), and the old owner cannot continue to write (fencing).
5. When an exception occurs, the system automatically recovers first; there are standard SOPs and executable commands for manual intervention.
6. The long-term inconsistent state of "`task.status` is terminal but there is still a pending user" is not allowed; it must be automatically compensated after detection (replay or mark failure reason).
7. The failure loop blind zone of "`no_pending_user` but the latest sdk continuously has the same error" is not allowed; the diagnosis must be explicitly classified as an execution layer fault.

---

## 3. Radical cure plan (must be implemented together)

Only single-point optimization (only adding timeout, only adding logs, only changing the front end) cannot cure the problem. It requires coordinated transformation of the execution layer + delivery layer + ownership layer.

### 3.1 Execution layer cure (solution type A)

Goal: Completely eliminate infinite waiting.

plan:

- Add a hard cutoff time (e.g. 12 minutes) outside `backendSession.runTurn()`.
- Split the turn into segments deadline: `start_turn`, `stream_start`, `stream_end`, `finalize`.
- Two-level recovery after timeout:
  - Soft recovery: cancel/ESC back to ready.
  - Hard recovery: Restart the TUI sub-process of the task and report `timeout_recovered`.
- Change `timeouts<=0 => Infinity` to "read default value + upper limit clamp" to disable unbounded configuration.
- Write `turn_journal`(reply_to, owner_epoch, phase, started_at, ended_at, result) every turn.

Code placement:

- `cli/bin/conductor-fire.js`
- `modules/tui-driver/src/driver/TuiDriver.ts`
- `modules/tui-driver/src/driver/profiles/codex.profile.ts`
- `modules/tui-driver/src/driver/profiles/copilot.profile.ts`

### 3.2 Delivery layer cure (solution type B)

Goal: Messages no longer depend on whether a certain instantaneous host is online.

plan:

- Upgrade "delivery by `agent_host`" to "delivery by `task_id`", consumed by the current owner:
  - Persistence `task_command_log`(`task_id`, `request_id`, `event_type`, `payload`, `state`).
  - The owner presses `task_id + cursor` to pull and ack, and the server advances the cursor.
- `sent` will automatically fall back to `pending` when timeout occurs and retry (exponential backoff + maximum retry + circuit breaker mark).
- Scheduled outbox/drain worker runs permanently and cannot be triggered only by websocket events.
- All defer/fail must have a structured reason, silent false is prohibited.

Code placement:

- `web/src/lib/realtime/agent-outbox.ts`
- `web/src/lib/realtime/agent-gateway.ts`
- Added `web/src/lib/realtime/task-command-log.ts` (recommended)

### 3.3 Ownership and fencing (solve host drift/double-write)

Goal: Only recognize one valid fire owner at any time.

plan:

- Add `task_owner_lease`:
  - `task_id`, `owner_host`, `owner_epoch`, `lease_expires_at`, `updated_at`。
- fire lease renewal every `5s`; automatically expires upon timeout and allows new owner claim.
- All `sdk_message/task_runtime_status/ack` must be accompanied by `owner_epoch`, which is verified by the server. If it does not match, it will be rejected.
- `agent_resume` claims lease successfully and then consumes the message.

Code placement:

- `web/src/lib/realtime/hub.ts`
- `web/src/lib/realtime/agent-gateway.ts`
- `cli/bin/conductor-fire.js`

### 3.4 Radical improvement of front-end visibility (solution type C)

Goal: Users always know what the system is doing.

plan:

- After sending the message, the runtime is not cleared and the placeholder status of "Sent, waiting for agent to receive" is displayed.
- If there is no runtime update for `T` seconds, "Processing interrupted, automatically recovering" is displayed.
- When pulling up the list on the home screen of the Task details page, the default is `recover_stale=1`.
- The UI status is deduced by integrating "server runtime + diagnostic signal" and does not rely on a single websocket event.

Code placement:

- `web/src/components/conductor/chat/ChatView.tsx`
- `web/src/lib/conductor/stores/tasks.ts`
- `web/src/app/app/tasks/[taskId]/page.tsx`

### 3.5 PTY life cycle cure (solution type D)

Goal: Eliminate the `process_exited -> already_spawned` infinite loop.

plan:

- `PtySession` must clean up the `ptyProcess` reference when onExit, not just set `_isRunning=false`.
- If the health in `ask()` is `process_exited`, the forced `restart()` is executed first, and it is prohibited to continue on the "repeat spawn conflict" path.
- Added `inFlight message id` deduplication for single task to avoid concurrent/duplicate processing of the same message id.
- Set circuit breakers and backoffs for consecutive errors of the same type (such as `PTY session already spawned`) to avoid swiping users with the same failure.
- `conductor diagnose` adds error content identification: `no_pending_user + latest_sdk=processing failed/PTY/TUI exited` directly outputs `execution_failure_loop`.

Code placement:

- `modules/tui-driver/src/pty/PtySession.ts`
- `modules/tui-driver/src/driver/TuiDriver.ts`
- `cli/bin/conductor-fire.js`
- `cli/bin/conductor-diagnose.js`
- `web/src/app/api/diagnostics/tasks/[taskId]/route.ts`

### 3.6 Acceptance and access (must pass)

- Chaos test:
  - Manually disconnect websocket for 30~120 seconds.
  - The fire process restarts, the daemon reconnects, and the network jitters.
  - 100 rounds each for codex / copilot long dialogues.
- SLO：
  - `pending_user_age_p95 < 30s`
  - `outbox_sent_stale_total = 0` (over threshold alarm)
  - `turn_timeout_total` is observable and automatically recovers
  - `pty_spawn_conflict_total = 0`
  - `terminal_with_pending_user_total = 0`
  - `execution_failure_loop_total` is observable and alarmable
- If you fail to pass the admission, you are not allowed to go online in full.

---

## 4. Implementation priority (radical version)

1. `R1` execution layer hard timeout + two-level recovery + disabling Infinity timeout.
2. `R2` PTY life cycle repair + message deduplication + failed circuit breaker (type D).
3. `R3` delivery layer is changed to task-level durable command log + timed drain.
4. `R4` owner lease + epoch fencing。
5. `R5` front-end status visibility modification.
6. `R6` chaos test and SLO admission.

---

## 5. SOP for responding to similar problems next time (can be executed directly on duty)

### 5.1 Goals

- Type (A/B/C/D) within 5 minutes.
- Business will be available again within 15 minutes (no need to restart the entire backend).
- Precipitate evidence and form a repair within 30 minutes.

### 5.2 Quick troubleshooting commands

Prefix variables:

```bash
export CONDUCTOR_CONFIG_FILE=~/.conductor/config.yaml
```

1) Find out the currently running task:

```bash
curl -s "$BACKEND_URL/api/tasks?recover_stale=1" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  | jq -r '.[] | select(.status=="running") | [.id, .agent_host, .created_at] | @tsv'
```

2) Task-by-task diagnosis:

```bash
conductor diagnose <task-id>
# ornode cli/bin/conductor.js diagnose <task-id>
```

3) Focus on the diagnosis code:

- `likely_runturn_stuck`: Type A
- `ws_or_routing_issue` / `routing_bound_to_daemon`: Type B
- `pending_but_processing`: Observation + Recheck
- `no_pending_user` but the latest sdk is `processing failed: PTY session already spawned` or `TUI process has exited`: type D (execution layer failure loop)

### 5.3 Disposal actions (by type)

#### A. `likely_runturn_stuck`

- Action:
  - Only restart the fire process corresponding to this task, and do not restart the entire backend.
  - `conductor diagnose <task-id>` again after restarting to confirm that the pending age has dropped.
  - If the same task is stuck twice in a row, mark the task `killed` and prompt the user to retry the latest message.
- verify:
  - See new `task_runtime_status` or `task_sdk_message` within 60 seconds.

#### B. `ws_or_routing_issue` / `routing_bound_to_daemon`

- Action:
  - Restore the fire websocket connection first (restart the corresponding fire process or repair the proxy connection).
  - Check whether it is rebind to the fire host and then trigger the outbox drain.
  - If `sent` appears in the outbox and has not been acked for a long time, implement the fallback and retry strategy (`sent -> pending`).
- verify:
  - The latest user message of this task corresponds to outbox entry `acked` or clear `failed`.
  - The pending age continues to decrease.

#### C. The status is blank but the background is not dead

- Action:
  - Refresh the task page and force pull `recover_stale=1`.
  - Use diagnostic results as status fallback (displaying "Waiting to receive/Processing/Recovering").
- verify:
  - UI status bar is no longer blank.

#### D. `execution_failure_loop` (or `no_pending_user` but the same sdk error persists)

- Action:
  - Restart the fire process corresponding to the task and confirm that the old child process (codex/copilot) has been cleaned up.
  - If the problem still recurs after 2 restarts, switch directly to the new task. The old task will be marked `killed` and the reason for the failure will be attached.
  - Immediately collect `PtySession`/`TuiDriver` logs to confirm whether `process_exited -> already_spawned` is hit.
- verify:
  - New messages no longer immediately return the same error.
  - `Processing message` can produce normal `sdk_message` instead of repeating the error template.

#### E. terminal but there is still a pending user (data is inconsistent)

- Action:
  - First determine whether the task is irrecoverable (killed/completed).
  - If it is not recoverable, create a new task and prompt the user to retry the last message.
  - If it is recoverable, perform "one-time compensation replay of the last pending user" and record the compensation audit.
- verify:
  - No more terminal + pending user coexistence.

### 5.4 Evidence collection template (must be retained for each incident)

- task id, user message id, occurrence time window (UTC+8).
- `conductor diagnose --json <task-id>` output.
- Key snippets of fire log:
  - `Processing message`
  - `turn waiting`
  - `runTurn completed`
  - websocket reconnect logging
  - `TUI process has exited`
  - `PTY session already spawned`
- outbox row status change (`pending/sent/acked/failed`).
- Whether there is "the same message id is processed repeatedly".
- The final disposal action and recovery time take.

---

## 6. Supplementary conclusions based on the new case

- case-1：`ec5208bb-6c81-4582-9c1a-6677ac212970`（`pySecureMR/examples/yolov8-cards/conductor.log`）  
  Features: A large number of reconnect/recover, final task `killed`, but there are still pending users.  
  Classification: Type B + terminal/pending inconsistent (requires compensation mechanism).
- case-2：`1d8bbb1e-ec04-498e-8866-9280c42e99ab`（`SpatialSDK.evt/conductor.log`）  
  Features: `TUI process has exited` first, then `PTY session already spawned` for a long time, and the same message id is processed repeatedly.  
  Classification: Type D (PTY life cycle necrosis), the current diagnosis will be covered by `no_pending_user`, and the diagnosis rules need to be upgraded.

---

## 7. Remarks

- What can be cured is system behavior such as "lost connection and silent freezing", not "the model never fails".
- If the external model/CLI fails accidentally, the system should still give a clear failure within the deadline and automatically recover, and should not be unresponsive for a long time.

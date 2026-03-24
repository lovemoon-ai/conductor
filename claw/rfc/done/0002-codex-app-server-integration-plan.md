# Codex App-Server access solution (Draft)
## background
The current main path of the `conductor-fire` driver Codex still relies on local TUI + session discovery:
- Launch `codex` interactive TUI- Infer the current session through `<codex-home>/state_5.sqlite` / `rollout_path` / `<codex-home>/sessions/**/*.jsonl` bypass- Then based on the rollout file, do reply stream, turn closing, resume binding
The core problem of this link is not "Codex did not start normally", but:
- `spawn ready` does not mean that the session metadata is visible to the outside world- discovery relies on external persistence side effects and naturally exists timing windows- In order to avoid string sessions, the current discovery conditions must be kept conservative.
turn out:
- Codex reply has been received- But the current round may still be misjudged as failed due to `checkpoint unavailable`
## Target
- No longer relies on sqlite / rollout file discovery to "guess" the current Codex session.- After Codex is started, get it directly from the official machine interface:  - `session_id`
  - `rollout_path`
- Use structured events to replace TUI screen capture and unify reply stream / runtime status / tool status.
## non-target
- This article does not contain this round of code implementation.- This article does not require the complete removal of rollout file reading; reply content can still continue to be consumed in the rollout/event stream.- This article does not cover Claude / Copilot access modification.
## Locally confirmed facts
Based on the local `codex-cli 0.104.0` (2026-03-08) verification:
- The normal interactive `codex` CLI has no exposed `--print-session` / `--print-rollout-path` parameters.- `codex app-server` provides JSON-RPC machine interface.- This agreement contains:  - `thread/started`
  - `sessionConfigured`
- `sessionConfigured` contains:  - `session_id`
  - `rollout_path`
- `rollout_path` is allowed to be `null`, for ephemeral thread.
This means: If you want to "get the session binding directly on startup", you should change to `codex app-server` instead of continuing to guess from outside the TUI.
## Plan Overview
### 1. Added Codex app-server backend
Add a backend channel to Codex that is independent of `tui-driver`:
- Start:`codex app-server --listen stdio://`- JSON-RPC via stdio- `conductor-fire` or independent session adapter is responsible for request/event distribution
It is recommended not to continue to superimpose this protocol on the existing `TuiDriver`, but to build a separate layer of `CodexAppServerSession`.
### 2. Change session startup to explicit binding
Recommended timing:
1. `initialize`
2. `thread/start`
3. Receive `thread/started`- Record `thread.id`4. Receive `sessionConfigured`- Record `thread.id`- Record `thread.id`- Immediately persist to task session binding5. `turn/start`

Effect:
- No more reliance on `<codex-home>/state_5.sqlite` query- No longer relies on `created_at/cwd/baseline` window matching- The session binding of the new task is changed from "Inference" to "Official Notification"
### 3. Change process status to structured event
`app-server` has provided turn/item level notifications, which can be directly mapped to runtime status:
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/reasoning/summaryTextDelta`
- `item/commandExecution/outputDelta`
- `item/mcpToolCall/progress`

Suggested mapping:
- `turn/started` -> `reply_in_progress=true`
- `item/reasoning/*` -> `phase=reasoning`
- `item/commandExecution/*` -> `phase=command_execution`
- `item/mcpToolCall/progress` -> `phase=mcp_tool_call`
- `item/agentMessage/delta` -> assistant incremental output- `turn/completed` -> Close the success/failure of the current round
### 4. "How long has it been working" is timed by the client itself.
`app-server` can give structured process status, but not directly in TUI style:
- `Working (12s ...)`

In the current agreement:
- turn level not explicit `durationMs`- command / MCP item can have `durationMs` after completion- There is no elapsed field that continues to grow during the ongoing phase
Therefore it is recommended:
- Received `turn/started` time note `startedAt`- The front end calculates `now - startedAt` based on the local clock- Stop watch when `turn/completed` is received
This retains the existing "job has been running for N seconds" UI experience, but changes the data source to structured events.
## Relation to current TUI scheme
### Directly replaceable parts
- session discovery
- TUI busy/status line extraction- snapshot/prompt diff driven turn state machine- Error closing due to missing checkpoint
### Parts that can be temporarily reserved
- rollout file reading and history recovery- reply stream deduplication logic- task session persistent binding- runtime status reporting protocol
In other words, there is no need to discard the rollout file all at once in the first phase; but the rollout file should be downgraded from "session binding premise" to "supplementary data source".
## Recommended implementation stage
### Phase 1: Minimum access
- Added `CodexAppServerSession`- Support `initialize -> thread/start -> turn/start`- Use `thread/started + sessionConfigured` to establish task session binding- assistant incremental output changed to `item/agentMessage/delta`
Target:
- First solve the misjudgment problem of session discovery / checkpoint unavailable
### Phase 2: Process status replacement
- Migrate runtime status from TUI screen signals to `turn/item` structured events- The front end displays elapsed working time by itself
Target:
- Remove Codex-specific TUI status capture and string parsing
### Phase 3: Closing and Compatibility
- Change Codex's TUI fallback to a debug switch instead of the default path- Add reconnection/failover strategy for app-server abnormal disconnection- Add resume / reconnect test
## Risks and Precautions
- `app-server` is currently an experimental interface, and the protocol fields may change after upgrading the Codex CLI.- `sessionConfigured.rollout_path` may be `null`; if you must rely on rollout files, you need to disable ephemeral or downgrade.- A lot of logic in the current system defaults to the Codex `tui-driver`. You need to carefully isolate the backend branch when switching to avoid affecting Claude / Copilot.- If two Codex paths (TUI and app-server) are reserved, the priorities must be clear to avoid double reporting.
## Verification list
- When creating a new Codex task, 100% obtain `session_id` from `sessionConfigured`.- After the front end has received the assistant's incremental output, the `checkpoint unavailable` failure message no longer appears.- `reply_to` binding remains correct under structured event paths.- `turn/started -> turn/completed` can stably drive the front-end working state and stop the watch.- The process status of command / MCP tool / reasoning can be displayed correctly in the UI.
## Recommended conclusion
For Codex:
- sqlite/session-file discovery should no longer be used as the primary bind path.- Should be changed to explicit session binding for `codex app-server`.- The rollout file is retained as a supplementary data source, not a precondition for turn success.
## state
- Document status:Draft- Current conclusion: save first, not implement in this round- Update time: 2026-03-08
# Goal

When a running turn produces no runtime status at all (not even fire's 60s heartbeat), work out the task's real state from the AI tool's own session logs (Claude / Codex / ...) instead of guessing, and show it to the user.

## Background

- The fire heartbeat (`CONDUCTOR_RUNTIME_HEARTBEAT_MS`, default 60s) and `POST /api/tasks/:id/runtime-status` already cover the case where fire and the provider are alive: the app shows the running tool and its elapsed time.
- When the web watchdog (`REPLY_IN_PROGRESS_WATCHDOG_MS`, 120s) still sees nothing, the web app no longer clears the reply locally, because that wrongly killed long tools. It re-asks fire every window and keeps the reply open. Stale-task recovery covers a disconnected fire.
- Still open: fire is connected but unresponsive (event loop blocked, worker hung, provider process wedged). Right now the app just keeps showing the last status, with no signal that it is stale.

## Inputs

- Claude session JSONL: `~/.claude/projects/<cwd-slug>/<session_id>.jsonl` (last `tool_use` with no matching `tool_result`, last entry timestamp).
- Codex session JSONL: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (the app-server `thread.path` is already stored as `session_file_path`).
- Other providers: kimi / opencode / copilot / dsh session stores (check each first).
- Task runtime context already carries `session_id` and `session_file_path`.

## Non-goals

- Do not replace the heartbeat; this is only the fallback when fire itself cannot answer.
- Do not kill or restart tasks based on this signal.

## Steps

1. For each provider, find where its session log lives, whether it can be read on the machine running fire/daemon, and how fresh its writes are.
2. Design the query path: the app asks → the server asks the **daemon** (a separate process from the stuck fire) → the daemon reads the tail of the session log → it returns `{ last_activity_at, active_tool?, last_event }`.
3. UI: once the heartbeat is overdue (e.g. more than 3 minutes), show "no update for N min, last activity: <tool> at <time>" in the status pill, so the user can tell a quiet task from a dead one.
4. Tests: an API route test for the daemon query, plus fixture-based parser tests for each provider's log format.

## Open questions

- Should the daemon, rather than fire, own this so it works when fire is wedged?
- Privacy: log tails contain tool inputs, so return summaries only (same 100-char limit as the status line).

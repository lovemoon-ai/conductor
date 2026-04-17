# stable: fire upstream commit fails on stale daemon binding (2026-04-14)

## Symptom
- A fire task could keep showing as `running` with a pending user message even though the fire process had already produced a reply.
- `conductor diagnose` showed `execution_host` on a fire host, but `realtime.bound_agent_host` still pointed at the original daemon.
- Fire logs showed repeated upstream failures such as:
  - `durable retry failed for sdk_message ...: Backend responded with 500`
  - `durable retry failed for agent_command_ack ...: Backend responded with 500`
- The actual reply text was visible in the fire log, but it never reached the task message list because `/api/agent/events` kept returning 500.

## Root Cause
- Ownership checks for agent upstream commits only handled one fire takeover case: a fire host claiming a daemon-owned AI task when the assigned host was still the daemon.
- They did not handle the adjacent stale-state case where:
  - `task.execution_host` already matched the fire host,
  - but the in-memory realtime binding still pointed at the daemon.
- In that state, the server treated the daemon binding as the active owner and rejected the fire host's `sdk_message` and `agent_command_ack` commits with errors like:
  - `Task <id> is already handled by active agent host <daemon>`
- Because the HTTP upstream route did not translate that ownership error into a non-500 application response, the SDK durable outbox kept retrying and the task looked stuck.

## Fix
- Update fire ownership reconciliation so a fire host may repair a stale daemon binding when:
  - the task is an `ai_task`,
  - `execution_host` / assigned host already matches the fire host,
  - and the current bound host is still a non-fire daemon.
- Apply the same rule in both upstream paths:
  - HTTP agent events ownership checks
  - websocket agent gateway ownership checks
- Add regression coverage for the stale-binding scenario so fire commits rebind the task instead of failing.

## How To Avoid Next Time
- Any ownership model with `agent_host`, `execution_host`, and in-memory binding must define how stale combinations reconcile, not just the ideal steady-state transitions.
- When fire takeover is supported, test all three host views together:
  - configured host,
  - persisted execution host,
  - realtime bound host.
- For reconnect and resume bugs, add regression cases for partially updated state, not only for fully old or fully new ownership.
- Treat repeated upstream 500s on `sdk_message` / `agent_command_ack` as a routing-ownership debugging signal, not only as a transport or provider failure.

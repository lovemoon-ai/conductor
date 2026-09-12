# ui: a message sent to a task whose host is gone shows no delivery-failure indicator in the chat

- Date: 2026-09-13 (QA round for the v0.12.0..2970043 release delta; mandatory scenario "Offline / timeout")
- Severity: P2 (minor) — pre-existing behavior, not introduced by this delta; diagnose surfaces the failure and the outbox keeps retrying, so nothing is lost
- Layer: web UI (task chat) over routing / outbox

## Symptom
Task `74232719` ran on `qa-old-daemon`; the daemon and its fire were killed with SIGKILL (non-graceful, simulating a host that vanished). The task stays `running` with `bound_agent_connected=false`. Sending "Reply with exactly QA913M7OFFLINE" from the web chat:
- the message renders as sent; after 15 s there is no reply and **no visual hint** (no "not delivered", no offline badge, the status pill still says `running`, the composer is re-enabled);
- `conductor diagnose` at the same moment reports `outbox.latest_for_pending_user.status=pending`, `attempt_count=1`, `last_error=send_to_agent_host_failed`, `diagnosis=ws_or_routing_issue` ("outbox cannot send to target agent host").

So the backend knows the delivery failed, but the user in the browser only sees a silent wait.

## Expected (QA SOP §5 "Offline / timeout")
The UI should surface a clear delivery-failure / host-offline state for the pending message (e.g. a "not delivered — host offline, retrying" marker or a task-level banner) instead of appearing to hang.

## Reproduction
1. Create a task on a daemon; wait for the first reply.
2. `kill -9` the daemon **and** its fire process (a graceful SIGTERM marks the task `killed`, which is a different, correct path).
3. Send a follow-up from the web chat; watch the chat and run `conductor diagnose <task-id> --json | jq .payload.outbox`.

## Evidence
- `claw/issues/tmp_release-qa-20260913/tmp_evidence/m7b-message-host-lost.png` (+ `.console.log`, `.network.log`)
- `claw/issues/tmp_release-qa-20260913/tmp_evidence/m7b-diagnose.json`

## Suspected component
`web/src/components` task chat: no consumer of the outbox `last_error` / host-connected realtime signal for the pending user message.

## Notes
The new-task dialog side of the same scenario is fine: with the daemon offline the device picker drops the host and shows the remaining devices (`m7-newtask-daemon-offline.png`).

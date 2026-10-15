# Scheduled message to a running fire task is not delivered until the fire reconnects

Severity: P1 (major). Pre-existing: reproduces on a v0.17.0 production build too, so it is not a 0.17.1 regression.
Found: 0.17.1 QA round, 2026-10-15. Layer: websocket / server routing.

## Symptom
A one-off scheduled message ("Schedule" in the message sheet, `conductor task schedule create <id> --delay 1m`, or the
quota auto-resume that fire schedules itself) fires on time: the row turns `sent` and the message appears in the chat.
The AI never answers it. Diagnose shows:

- `outbox.latest_for_pending_user.status = pending`, `last_error = send_to_agent_host_failed`, `attempt_count = 1`
- `realtime.assigned_agent_connected = true`, so the fire host is connected
- no retry for as long as I watched (10+ min)

It is delivered only when the fire reconnects (`drained outbox ... delivered=1` after a server restart). A message sent
the normal way (UI composer or `conductor task send`) to the same task at the same moment arrives at once.

## Reproduction
1. Run a task through a daemon (any version: 0.17.0 published, or the 0.17.1 candidate) and let it finish a turn.
2. `conductor task schedule create <task> "reply TOKEN-X" --delay 1m`
3. Wait 2 min. The message shows in the chat, but there is no reply and the outbox row is `pending / send_to_agent_host_failed`.

Reproduced on: `tsx server.ts` dev, a production build at e3851eb/5cb96d3 (`pnpm build && pnpm start`), and a production
build of v0.17.0, all against the same dev DB. Reproduced on fires from daemons A (dev source / 0.17.1 RC), B (dev source)
and the 0.17.0 published daemon.

## Evidence
A temporary log in `RealtimeHub.sendToAgentHost` (reverted afterwards) caught misses from the Next route bundle:
the hub instance there had `connections.size = 2` (browser connections only) and was `globalThis.realtimeHub`, while the
agent gateway had 8 agents connected. One scheduled send also failed without reaching the instrumented `server.ts` hub
copy at all. So the scheduled-message send runs against a hub instance that does not hold the agent sockets.
Evidence: `claw/issues/tmp_release-qa-0171-20261015/tmp_evidence/qr_r2_resume_diag.json` (local).

## Impact
- Scheduled messages to running tasks silently stall.
- 0.17.1 quota auto-resume: the resume message lands only after a reconnect, or when the user writes again (fire then
  ends the wait itself, which works).
- The 0.16.0 "scheduled message starts the next persistent round" path is different (idle task) and still works.

## Suggested direction
Make sure the scheduled-message dispatcher and every outbox send resolve the same `RealtimeHub` instance the agent
gateway registers sockets on. Also retry `send_to_agent_host_failed` rows for connected hosts instead of waiting for a
reconnect. Test with a scheduled message to a running fire task on a production build.

Lesson required: yes, this is a user-facing bug (`claw/lessons/stable_...`).

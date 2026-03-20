# stable: fire mixes history playback and session stream, causing chaotic recovery (2026-03-06)

## Symptoms
- When users use Codex on `conductor-fire`, two types of phenomena occasionally occur:
- After fire is started, the same user message is fed to the backend again, causing prompt to rerun or the context to be confused.
- Codex has obviously generated a reply in the session file, but the app side has not received a complete reply or Working status in time.
- The results seen on the user side are usually:
- The same round of questions is repeated
- Replies are delayed, missing, or only incomplete
- It is more likely to appear "It looks restored, but the message link is not clean" after reconnect / fresh startup

## Root Cause
- The old implementation mixed two links with different semantics:
- User message recovery not only consumes the live queue, but also performs additional DB-history backfill in startup / reconnect scenarios.
- Codex assistant replies can already be incrementally read from the session file, but fire still mainly relies on the final text result of `runTurn()`
- This creates two immediate problems:
- Historical replay will hit the same message as server durable outbox/live queue, resulting in repeated delivery
- The incremental replies and Working status in the session file are not continuously forwarded, resulting in the app having to wait for the turn to finally stop.

## Fix
- Delete the DB-history backfill in the startup phase, and only consume user messages from the live queue after fire starts.
- The DB history will not be replayed by default after reconnect, and only the explicit debugging switch will be retained.
- Add session-file incremental monitoring for Codex:
- The assistant replies to the reply target and continues to forward it to Conductor
- `Working (...)` status will continue to be reported outside of `runTurn()`
- No longer consider `runTurn()` return text as the only source of Codex replies
- Add regression testing to cover:
- startup only processes the live queue and does not read the task history
- Codex session file can continuously forward multi-part replies
- `Working` status can continue to be reported outside the turn life cycle
## Prevention
- Do not regard "compensation based on historical inference" and "deterministic delivery based on real-time queue" as the main link at the same time.
- For the session-file backend, treat the incremental event stream as a first-class output source, rather than just treating it as auxiliary information before final closure.
- The three recovery paths of startup, resume, and reconnect must be designed and regression tested separately to avoid continuing to replay old messages in another place after one is repaired.
# `/stop` does not interrupt a 0.16.0 fire during the task's initial-prompt turn

- Severity: P2 (mixed version only, initial turn only; degrades without hanging)
- Layer: routing / mixed version (`interrupt_turn` target)
- Found by: release QA round 3, build `25dd30b` web + published CLI 0.16.0 daemon `qa-old-daemon`, 2026-10-04. Re-verified once (task 77ce6df9).

## Reproduction
1. Web @25dd30b. Daemon `qa-old-daemon` runs the published 0.16.0 CLI.
2. Create a claude task on that daemon whose **first** prompt runs a long foreground command (`python3 -c 'import time; time.sleep(180)'`).
3. About 25 s in, send `/stop` (CLI or web).

## Observed
- The fire log shows `Received interrupt_turn for <task> replyTo=initial (user_stop)`, but the turn keeps running until the command finishes.
- The queued `/stop` is then handed to the model, which answers `/stop isn't available in this environment.`
- The same old fire **does** stop a later turn within 2 s (`replyTo=<message id>`), so only the initial-prompt turn is affected.

## Expected
The changeset says "the server targets the reply it knows is running, so older fires stop it too". For a 0.16.0 fire, the initial turn needs a target it recognises. Otherwise the limitation should be documented as "upgrade the CLI to stop the first turn".

## Evidence
`/private/tmp/tmp_qa1003_ws_old/conductor.log` (fire log); tasks ba572721 and 77ce6df9; `claw/issues/tmp_release-0.17-qa-20261004/tmp_evidence/st6_diagnose_live.json`.

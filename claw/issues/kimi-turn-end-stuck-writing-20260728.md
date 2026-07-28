# P2 — Kimi reply finishes but the task remains in writing state

## Symptom

A Kimi reply is already visible and the provider wire has emitted `TurnEnd`,
but the web task remains on **Kimi is writing the reply**. The normal Send
button is unavailable until the page is refreshed or another recovery event
clears the live state.

## Environment

- Local `main`-reachable build `0a0b0b8`.
- Web: fresh `make run-dev`, `http://localhost:6152/`.
- CLI/daemon: freshly built `./bin/conductor-dev` from the same build; one
  `debug` daemon.
- Browser: Playwright 1.60 over CDP to a signed-in Chrome 150 profile.
- Task: `d7255867-ab25-4d60-8067-15481c67c21b`.
- Kimi session: `615cdfa8-e61b-4e62-b3fe-d6606b6bb4a8`.

## Reproduction

1. Create a Kimi AI task.
2. Send a short prompt and wait for its reply.
3. Without reloading, send a second prompt:
   `Reply with exactly KIMI-R7-FOLLOWUP and nothing else.`
4. Observe the exact reply.
5. Confirm the wire log records `TurnEnd`.
6. Continue observing the web task for at least 90 seconds.

## Expected vs observed

- Expected: the working indicator clears at `TurnEnd`, **Kimi finished**
  appears, and the normal Send action is available.
- Observed: the exact reply was visible and `TurnEnd` was recorded at
  `1785221900.4249432`, but more than 90 seconds later the task still showed
  **Kimi is writing the reply**, did not show **Kimi finished**, and exposed no
  Send button.

The first turn in the same task eventually cleared and allowed the second
message without a reload, so the failure remains intermittent by turn.

## Severity

**P2 (minor).** The reply is preserved and a page reload can recover the task,
but the live conversation appears permanently busy and cannot continue
normally.

## Suspected component

Final-state propagation between the Kimi provider event stream and the web
working-status state.

## Diagnostics and evidence

- CLI diagnose: `fallback: failed to fetch task (404)` because this web-created
  task is outside the CLI agent-token scope.
- Wire log:
  `/Users/duino/.kimi/sessions/4e815b0adf9f526e11e1fa55d9f0e413/615cdfa8-e61b-4e62-b3fe-d6606b6bb4a8/wire.jsonl`.
- QA summary:
  `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round7/tmp_evidence/tmp_r7_c2_result.json`.
- Screenshot:
  `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round7/tmp_evidence/tmp_r7_c2_kimi_turnend_90s_stuck.png`.

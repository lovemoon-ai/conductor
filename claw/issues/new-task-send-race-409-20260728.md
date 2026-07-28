# P2 — newly created task accepts input before message delivery is ready

## Symptom

Immediately after creating an AI task, the task detail pane exposes an enabled
Message input and Send button. Sending during this startup window returns
`409 Conflict`; the user message is not persisted or delivered. The UI shows
`Failed to send the message. Please try again in a moment.`

Waiting until the provider session-start event appears and retrying succeeds.

## Environment

- Local `main` at `6eea8eb`.
- Web: `make run-dev`, `http://localhost:6152/`.
- CLI/daemon: freshly rebuilt `./bin/conductor-dev`; `make debug-cli`;
  daemon `debug`.
- Browser: Playwright 1.60 over CDP to Chrome 150, signed-in QA profile.

## Reproduction

1. Open the Tasks page.
2. Click Create task.
3. Enter an AI task title and click Create AI Task.
4. As soon as Message input becomes visible, enter a message and click Send.
5. Observe the POST to `/api/tasks/<id>/messages` and the visible error.

Reproduced on two independent tasks:

- `ba6aba60-8a7a-4cce-a966-a8b7572e4b50`
- `3ded2223-c4df-49cb-a9f3-83548490c5c0`

Both immediate sends returned HTTP 409 and produced no persisted user message.
On the first task, waiting for `codex session started` and retrying returned
HTTP 200 and produced `QA_R5_C0_RETRY_OK`.

## Expected vs observed

- Expected: until a new task can accept a user message, Send remains disabled
  or the message is queued; an enabled Send action must not discard the input.
- Observed: the UI enables Send before the backend accepts messages. The POST
  returns 409 and the user must manually retry.

## Severity and classification

- Severity: **P2 (minor)** — the first send attempt is lost, but waiting until
  the session-ready signal and retrying is a stable workaround.
- Classification: **known pre-existing issue, not a release regression**. QA
  review confirmed the behavior predates v0.7.7 (present before the 2026-04
  commit `eee2f6a`) and the current release diff did not change fire-owner
  validation.
- Suspected layer: **final state / UI readiness synchronization**.

## Confirmed root cause

QA review confirmed the frontend enables Send when `task.status === 'running'`,
while the message API accepts a user message only after `execution_host` is
bound to a `conductor-fire-*` process. The daemon can mark the task running
before that fire binding completes, leaving a short readiness gap in which the
API returns `409 TASK_MISSING_ACTIVE_FIRE_OWNER`.

## Evidence

- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_happy_path_failure.png`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_happy_path.json`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_diagnose_live.json`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_send_race_repro.png`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_send_race_repro.json`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_send_race_diagnose_live.json`
- Successful workaround:
  `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_c0_retry_ready.json`

## Fix handoff

Because this is a normal product-usage bug, its eventual fix must add a
corresponding `ui` lesson under `claw/lessons/` before commit.

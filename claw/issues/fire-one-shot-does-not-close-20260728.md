# [CLOSED — NOT A BUG] P0 — one-shot `conductor fire` does not close after replying

## Resolution (2026-07-28): 经复核不成立,关闭

- **Status: CLOSED — not a product defect (invalid).** Reclassified from P0 after source review.
- **Root cause of the report:** a QA-method / expectation mismatch, not a code defect. `conductor fire ... -- "<prompt>"` is a **persistent bridge process, not a one-shot CLI**. The prompt is the task's *initial* message; after replying, fire intentionally keeps serving the task and polling for further messages. There is no code path that self-exits after a single reply, and none was ever designed.
- **Code evidence** (`cli/bin/conductor-fire.js`):
  - Prompt is only the initial message: `:1408` / `:1425` (`initialPrompt: prompt || ...`).
  - Serve loop runs until an external stop: `while (!this.stopped)` at `:2264`; `this.stopped` is set only by SIGINT/SIGTERM (`:924-937`), remote `stop_task` (`:2326`), or abortSignal (`:2232`) — never by "reply delivered".
  - The only auto-exit timer is gated on `if (isChatWebTask)` with a 24h default (`:944-958`) and does not apply to the codex backend.
  - Graceful final status (`sendTaskStatus COMPLETED/KILLED`) lives at `:1071-1128` and runs only on a clean stop.
- **Why the task stayed `running`:** the QA **hard-killed** the process after its own 120s/45s timeout, bypassing the graceful shutdown at `:1071-1128`; the server therefore never received a terminal status. Residual `running` with a disconnected host is the expected consequence of force-killing a live agent host, not a lifecycle bug. Diagnose confirmed a healthy pipeline throughout (`no_pending_user`, outbox all `acked`).
- **Correct verification going forward:** drive the flow through the daemon, or send SIGINT/`stop_task` and then confirm `diagnose` shows the task settled; never SIGKILL and judge close. Also do not run fire nested inside another fire/codex session (inherited `CONDUCTOR_TASK_ID` → `missing task` errors).
- **SOP updated to prevent recurrence:** `claw/sop/05_qa.md` — new binding **Fire lifecycle rule** + rewritten §5 manual-fire scenario.
- No `claw/lessons/` entry is required: this is not a product bug, so the `stable`-lesson handoff below is void.

---

## Symptom

`./bin/conductor-dev fire --config-file ~/.conductor/config-dev.yaml --
"<prompt>"` receives and prints the correct AI reply, but the command remains
alive indefinitely. When the process is terminated by the caller, the task
remains `running` even though its fire host is disconnected and no user message
is pending.

## Environment

- Local E2E on `main`; product sources at `5fef287`.
- Closing repository HEAD `9c5a875` only updates the QA SOP.
- Web: `make run-dev`, `http://localhost:6152/`.
- CLI: `./bin/conductor-dev` built by `make debug-cli`.
- Backend: codex, local config `~/.conductor/config-dev.yaml`.

## Reproduction

1. Start the local server with `make run-dev`.
2. Start the local daemon with `CI=true make debug-cli`.
3. Run
   `./bin/conductor-dev fire --config-file ~/.conductor/config-dev.yaml --
   "Reply exactly FIRE_R3_OK"`.
4. Wait for the correct reply.
5. Continue waiting for the one-shot command to exit.
6. Terminate the command after it remains alive, then run
   `./bin/conductor-dev diagnose <task-id> --config-file
   ~/.conductor/config-dev.yaml --json`.

The issue reproduced twice:

- Task `8c8d63ce-1322-48b9-bce8-12ec7ffd2211`: correct reply at 11 seconds;
  command still alive at 120 seconds.
- Task `d877dceb-982c-4739-856c-95726f0f0b87`: correct reply at 8 seconds;
  command still alive at 45 seconds.

## Expected vs observed

- Expected: the mandatory manual-fire flow receives its reply, marks the task
  closed, and the one-shot command exits cleanly.
- Observed: reply is delivered, but the command does not exit; after forced
  termination, diagnose reports `source=live`, `task.status=running`,
  `assigned_agent_connected=false`, `connected_fire_hosts=[]`, and
  `has_pending_user=false`.

## Severity and suspected layer

- Severity: **P0 (blocker)** — C0b is a P0 release exit criterion and the core
  manual-fire flow cannot close cleanly.
- Suspected layer: **final state / fire lifecycle**.

## Evidence

- `claw/issues/tmp_release-post-v0.7.7-qa-20260727/tmp_evidence/tmp_round3_C0b_fire_run_1.txt`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260727/tmp_evidence/tmp_round3_C0b_fire_run_2.txt`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260727/tmp_evidence/tmp_round3_C0b_diagnose_run_1.json`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260727/tmp_evidence/tmp_round3_C0b_diagnose_run_2.json`

## Fix handoff

Because this is a normal product-usage bug, the eventual bugfix commit must add
one `stable` lesson under `claw/lessons/` as required by the repository review
guidelines.

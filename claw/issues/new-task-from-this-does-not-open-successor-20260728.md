# P2 — New task from this leaves the source task selected

## Symptom

Using **New task from this** creates the successor and automatically groups it
with the source, but the task detail remains on the source task. The new tab is
visible and can be opened manually.

## Environment

- Local `main` at `6eea8eb`.
- Web: fresh `make run-dev`, `http://localhost:6152/`.
- CLI/daemon: freshly rebuilt `./bin/conductor-dev`; `make debug-cli`.
- Browser: Playwright 1.60 over CDP to Chrome 150, signed-in QA profile.

## Reproduction

1. Open a stopped task in the all-tasks list.
2. Left-swipe the task card and select **New task**.
3. Keep the default backend and confirm **New task**.
4. Observe the new grouped tab and current task URL.

Reproduced twice:

- An already-grouped source
  `8f4dc097-4b1d-4d63-b61e-457e49587e2f` created successor
  `1815e728-558a-4e53-a7e3-7332e41751eb`.
- An ungrouped source
  `7e4fa33e-6169-4c30-9fba-8410b588081b` created successor
  `35bc00f1-bc47-4972-8843-54e5bff477f1`.

Both restart requests returned HTTP 200 and both successors appeared in the
correct merged group. After waiting, the URL and selected tab still referenced
the source. Clicking the successor tab manually opened it successfully.

## Expected vs observed

- Expected: after creating a successor, the successor is grouped with its
  source and opened as the selected task.
- Observed: grouping succeeds, but the source remains selected.

## Severity

**P2 (minor).** The successor is created and discoverable without data loss;
the user can open it with one additional tab click.

## Evidence

- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_f4_branch_grouped.png`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_f4_clean_branch_grouped.png`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_f4_manual_open_successor.png`

## Fix handoff

Because this is a normal product-usage UI bug, its eventual fix must add a
corresponding `ui` lesson under `claw/lessons/` before commit.

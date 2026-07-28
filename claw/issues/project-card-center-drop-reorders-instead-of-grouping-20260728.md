# P1 — dropping a project card on another card never creates a tab group

## Symptom

Dragging one project card onto the middle of another only reorders the project
list. No aggregated project card or project tabs appear.

## Environment

- Local `main` at `6eea8eb`, including `44cf2b6`.
- Web: fresh `make run-dev`, `http://localhost:6152/`.
- Browser: Playwright 1.60 over CDP to Chrome 150, signed-in QA profile.
- Projects: `Default Project`, `conductor`, and temporary
  `qa-r5-project-card-temp`.

## Reproduction

1. Open Projects.
2. Hold a project's **Drag project** handle.
3. Drop it on the middle of another project card.
4. Observe the cards, tabs, and network requests.

The behavior was checked with both a two-project list and a three-project list.
Exact-center, center-offset, quick-release, held, and standard drag-to gestures
all produced the same outcome.

## Expected vs observed

- Expected: a middle drop aggregates the source and target into one tab card;
  an edge drop remains available for reorder.
- Observed: the middle drop posts to `/api/projects/reorder`, the cards change
  order, and no project tab group is created. There is no project-card-groups
  preference write.

A second signed-in browser page received the reordered/created project list in
real time but also showed zero project tabs. Cross-client tab synchronization
cannot be exercised because the initiating client cannot create a group.

## Severity

**P1 (major).** The primary user path for the release feature is unavailable;
the existing project list and projects remain intact.

## Evidence

- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_f7_before_group.png`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_f7_group_attempt_3.png`
- `claw/issues/tmp_release-post-v0.7.7-qa-20260728-round5/tmp_evidence/tmp_round5_f7_page_b_no_group.png`

## Fix handoff

Because this is a normal product-usage UI bug, its eventual fix must add a
corresponding `ui` lesson under `claw/lessons/` before commit.

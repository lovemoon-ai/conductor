# misc — QA synthetic events can phantom a filter bug

## Symptom

QA round on the project-collaboration feature (`tmp_project-collaboration-20260512`) filed **BUG-002**: "hidden projects still render in the project list when the *show hidden* toggle is OFF." The evidence:

- Card had `opacity: 0.7` after a swipe → "Hide project" click sequence driven by `chrome-devtools` MCP `evaluate_script`.
- Heading hint read `Double-click to show hidden projects` — i.e. `showHiddenProjects = false`.
- `localStorage["conductor-show-hidden-projects"]` was `null`, consistent with the OFF state.
- The card was still in the DOM.

That combination looks like a list-filter bug: state says "should be hidden" but the row renders.

## Root cause — false positive

The bug **does not reproduce in code**. Two independent sources of confusion combined:

1. **`opacity-70` is not the "hidden" marker.** `ProjectItem` applies `opacity-70` to the outer card *only* when `isPendingBinding || isUnavailable` — i.e. the daemon binding hasn't been confirmed or the daemon is offline. The hidden-state visual is a *different* element: the drag-handle icon switches to a dashed-stroke variant inside the card. The QA round's target project had `daemonHost: "qa-host"` with no daemon online, so it was rendering with `opacity-70` for binding-pending reasons regardless of hidden state.

2. **chrome-devtools MCP `evaluate_script` runs in an isolated world.** Dispatching `button.click()` from inside `evaluate_script` does propagate to React's `onClick`, but the surrounding swipe-drawer state machine in `useSwipeActions` had been driven by a synthetic `pointerdown` / `pointermove` / `pointerup` sequence whose timing differs from a real touch / mouse swipe. In some runs the click landed before the optimistic re-render flushed; in others the click never fired against a target the swipe drawer recognized. The reproduction is non-deterministic from inside the isolated context.

The production filter is correct: `ProjectList.visibleProjects` filters by `showHiddenProjects || !hiddenProjectIdSet.has(project.id)`, the store's `hideProject` action sets both `hidden: true` and `showHiddenProjects: false` synchronously inside the same `set(...)`, and `collectHiddenProjectIds` populates the id set from `project.hidden === true`. None of these layers misbehave.

## Fix

No production code change. The contract is hardened by a new integration test that wires the *actual* zustand store to the *actual* `ProjectList` component:

`web/src/features/projects/components/ProjectList.hide-integration.test.tsx` — 3 cases:

1. `hideProject` via the real store removes the card from the rendered list when `showHidden=false`.
2. Toggling `showHidden` back to `true` brings the card back (rendered with `data-hidden="true"`).
3. A project that arrives as `hidden:true` from the API (e.g. a fresh `fetchProjects` after another tab hid it) is filtered out without an optimistic-update step.

Previously the unit suites for the store and for `ProjectList` each proved their own contract but did not exercise the round-trip. The new file closes that gap so any future regression that *could* produce the QA-observed symptom would surface as a failing test long before reaching QA.

## How to avoid next time

1. **QA filing a list-rendering inconsistency MUST cross-check `opacity-*` against the source of the dimming before promoting it to a bug ticket.** The conductor codebase has at least three independent "dim" reasons: pending binding, offline daemon, and drag-overlay shadow. Conflating any of them with "this row is in a hidden state" is the trap that produced BUG-002.

2. **When a UI filter looks broken from the QA driver, write an integration test that flows the real store through the real component before opening a ticket.** The QA SOP keeps us in black-box mode during the round; but the *re-verification* phase (before promotion from `tmp_*` to `claw/issues/<bug>-<date>.md`) is the right time to drop into white-box mode and verify the reproduction is real, not driver-induced. The cost is ~30 lines of test code; the saved effort is everything you'd have spent chasing the phantom.

3. **`chrome-devtools` MCP `evaluate_script` is fine for assertions on rendered DOM but is fragile when used to simulate touch / pointer gestures whose state machines depend on real timing (swipe drawers, long-press handlers, drag-and-drop).** Prefer real user input where the gesture state matters; if forced to script it, capture both before and after snapshots at multiple time points and treat single-shot reads as inconclusive.

## Related

- QA round folder: `claw/issues/tmp_project-collaboration-20260512/` (local-only, untracked).
- Addendum recording the re-verification: `tmp_test_report_addendum.md` in the same folder.
- Integration test: `web/src/features/projects/components/ProjectList.hide-integration.test.tsx`.
- Production code (unchanged): `web/src/features/projects/components/ProjectList.tsx`, `web/src/features/projects/store.ts`, `web/src/features/projects/components/ProjectItem.tsx`.

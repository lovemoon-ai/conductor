# Goal

Virtualize the task list (`web/src/features/tasks/components/TaskList.tsx`) so
the mounted DOM/React cost is O(viewport), not O(task count). This fixes the
remaining "opening / switching pages feels laggy" symptom at 130+ tasks WITHOUT
the UX regressions of the reverted progressive-mount attempt.

Background: `#1` backend preview query and `#2` TaskItem `React.memo` + per-action
store selectors already landed on `main` (commit `70c4956`) and fixed the main
"using-it-while-tasks-run" re-render storm (162 -> 1 re-render per update). A
third attempt — "progressive mounting" (cap initial mount to 24 rows, grow via
IntersectionObserver) — was committed (`e06c425`) then reverted (`d24032c`)
because it introduced real UX problems (see Non-goals / lessons below). This task
is to do it properly with true windowed virtualization.

## Inputs
1. Start server locally: `cd web && unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY && pnpm build && pnpm start` (port 6152).
2. Login headless without SMS: mint a JWT with the local `JWT_SECRET` and inject `localStorage['conductor.jwt']` (the user id is in the local DB); or drive the UI with `env:CONDUCTOR_PHONE` + dev code. See the reusable Playwright harness in `/tmp/conductor_perf/` from the investigation session (seed script `seed_frontend.sh <N>`, measure scripts `fe_progressive.mjs` / `fe_rerender.mjs`). Repo-root has Playwright 1.60; run measure scripts from repo root (ESM resolves `playwright` there).
3. Seed a 159-task scratch DB (matches the real lagging user) and point `pnpm start` at it via `DATABASE_URL=file:/tmp/conductor_perf/scratch.db` (exported inline — `.env` overrides `.env.production.local`, so an exported var is the reliable override).

## Non-goals
1. Do NOT reintroduce "progressive mounting" (growing content height as you
   scroll). It made the scrollbar thumb jump/resize, made the list look like
   tasks were missing (only 24 shown initially), and broke browser find-in-page.
   True virtualization must reserve the full scroll height (spacer) so the
   scrollbar is stable and accurate.
2. Do not change selection / counts / select-all semantics — they already
   operate on the full task set and must keep doing so.
3. Do not regress drag-to-merge, swipe actions, tab-card merged groups, project
   grouping, or the FLIP reorder animation.
4. Do not touch `#1`/`#2` (already shipped and validated).

## Steps
1. Use `codemap` / read `TaskList.tsx` render structure. Key facts already found:
   - Rows come from `buildTaskCardRows(visibleTasks, renderGroups)` -> flat array
     of `{type:'task', task}` | `{type:'group', group}` (merged tab-card, has a
     tab strip on top => taller). Rendered in the `space-y-3` container map
     (~line 1366 pre-revert numbering).
   - The SCROLL CONTAINER lives in the PARENT `page.tsx`, not in TaskList: the
     desktop inline pane at `page.tsx:509` (`overflow-y-auto`, narrow column) and
     the single-pane/mobile branch at `page.tsx:541`. Virtualization needs the
     scroll element ref -> pass it down from page.tsx, or resolve the scroll
     parent via DOM in TaskList.
   - Drag hit-testing iterates `rowRefs` (Map<rowId, HTMLElement>) and calls
     `getBoundingClientRect()` over rows (~lines 843-968) to compute
     `dropTargetId`. Virtualized (off-screen) rows have no ref.
   - Two render branches (inline pane + single-pane) both render `<TaskList>`.
2. Add `@tanstack/react-virtual` (`cd web && pnpm add @tanstack/react-virtual`).
   Chosen over react-window because rows are variable height and it supports
   `measureElement` dynamic measurement + a stable total-size spacer.
3. Wire the scroll container: pass a `scrollElementRef` (or a `getScrollElement`)
   from page.tsx into TaskList for BOTH branches, or use the virtualizer's
   ability to observe the nearest scroll parent. Reserve full height via the
   virtualizer's `getTotalSize()` spacer so the scrollbar is correct/stable.
4. Replace the `taskCardRows.map(...)` with a virtualized render: only the
   virtual items (visible + small overscan) render; position each with the
   transform/offset the virtualizer gives; keep the existing per-row wrapper
   (drag/pointer/touch handlers, `setRowRef`, `renderTaskItem`) intact for
   rendered rows. Use `measureElement` so task rows vs tab-card group rows get
   correct heights.
5. Make drag-to-merge work with virtualization: the drop target is always a
   VISIBLE row, so geometry hit-testing over currently-rendered `rowRefs` still
   works. Verify autoscroll-during-drag (dragging toward top/bottom edge) still
   scrolls; if it relied on off-screen row rects, adapt to use the scroll
   container edges instead. Document any accepted limitation (e.g. can't drop
   onto a row that is scrolled far off-screen — you drag onto a visible one).
6. Keep selection/counts/select-all on the full `taskCardRows`/`allTaskIds`
   (unchanged). Only the RENDER is windowed.
7. Tests: add a TaskList test (mock the virtualizer or assert only a window of
   `task-item-*` testids render for a large list while the full count still
   drives select-all label). Keep all existing 28 tests green.

## Rules
1. Turn off proxies before local testing: `unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy`.
2. The scrollbar MUST stay stable (full height reserved) — no growing-height jank.
3. Drag/swipe gestures cannot be reliably tested via Playwright headless — they
   require MANUAL local verification (drag a card onto another to merge; swipe a
   card for actions; open/rename/unmerge a tab-card group). Do not claim done
   until these are manually verified locally.
4. Preserve `#2`: TaskItem stays `memo`'d and rows keep referentially-stable
   props so virtualized re-renders remain cheap.

## Implementation points
1. `@tanstack/react-virtual` `useVirtualizer({ count, getScrollElement, estimateSize, measureElement, overscan })`.
2. Scroll element ref threaded from `page.tsx` (509 & 541) into `TaskList`.
3. Absolute-positioned virtual rows inside a `position: relative; height: getTotalSize()` container; each row `ref={measureElement}` + existing wrapper handlers.
4. `dropTargetId` geometry loop already only needs rendered rows — no change beyond confirming refs register for virtual rows.

## Acceptance criteria
1. Mounted DOM node count stays ~constant (O(viewport), a few hundred elements)
   whether there are 20 or 500 tasks — verify via CDP `Performance.getMetrics`
   `Nodes` with the harness.
2. Initial-render `ScriptDuration` at 159 tasks < ~120ms unthrottled (baseline
   pre-virtualization was ~340ms; progressive-mount got 82ms but with UX
   regressions — match or beat it WITHOUT them).
3. Scrollbar length/position is stable and accurate while scrolling (no jump).
4. Browser find-in-page limitation is understood/accepted (virtualization
   inherently only has visible rows in DOM) — note in PR.
5. Drag-to-merge, swipe actions, tab-card groups (click/rename/unmerge), project
   grouping headers, select-all, and the reorder animation all work — MANUALLY
   verified locally.
6. All existing TaskList/TaskItem tests green + one new windowing test.

## Risks and rollback
1. Risk: high regression surface on drag-to-merge / swipe / FLIP animation and on
   the two different scroll-container layouts (inline pane vs single pane).
2. Mitigation: land behind an easy revert (single commit) and manual local QA of
   all gestures before merge; consider a feature flag if uncertain.
3. Rollback: revert the virtualization commit; `#1`/`#2` are independent and stay.

## Baseline numbers (measured this investigation, 159 tasks)
- Pre-virtualization initial render: ~340ms script / ~15k DOM nodes (unthrottled); ~543ms / 4x throttled.
- Page-switch return rebuilt ~15,800 DOM nodes.
- Reverted progressive-mount hit 82ms / ~3.5k nodes but caused scrollbar jump + "missing tasks" look + find-in-page break (why it was reverted).

## Done
Task list is windowed with true virtualization: O(viewport) DOM regardless of
task count, stable scrollbar, all gestures/grouping/selection preserved and
MANUALLY verified locally, tests green.
Do not stop until the done condition is satisfied.

# Task-card merge cards not shown in the all-tasks view

## Symptom
Merging two task cards in the task list (drag one card onto another to form a
"tab card") worked while a specific project was selected, but the merged card
did **not** appear when the list showed **all** tasks (no project selected).
The merge seemed to silently vanish when switching to the all-tasks view.

## Root cause
Tab-card grouping state was persisted and loaded **per project filter**. In
`web/src/features/tasks/components/TaskList.tsx`, the group storage/sync scope
was derived from `graphStateKey`:

```ts
const projectScope = effectiveProjectFilterIds.length > 0
  ? [...effectiveProjectFilterIds].sort().join(',')
  : 'all';
return `projects:${projectScope}`; // → "projects:<id>" or "projects:all"
```

That single `graphStateKey` keyed **both** the graph-canvas layout (which
legitimately needs a per-project scope) **and** the list tab-cards. As a result
a card merged inside "Project One" was saved only under `projects:project-1`,
while the all-tasks view read from the separate `projects:all` bucket — so it
was empty there. Merges were effectively siloed per project selection.

The graph scope-per-project reuse was the trap: list tab-cards are conceptually
global (a merge is a merge regardless of the active filter), but they inherited
the graph view's per-project scoping.

## Fix
Decouple the list tab-card scope from `graphStateKey`. List cards now always use
a single global scope, `LIST_CARD_GROUPS_SCOPE = 'projects:all'`
(`web/src/features/tasks/utils/task-card-groups.ts`). `graphStateKey` stays
per-project and is still passed to `TaskGraphView`.

To surface merges created before the fix (still stored under `projects:<id>`
scopes on the server), the hydrate effect now folds **every** project scope into
one working set via the new `consolidateSyncedTaskCardGroups()`:
- The global scope is folded first so, on group-id collision, its device-active
  tab wins and the union is stable/idempotent across reloads.
- A task belongs to exactly one project, so per-scope groups are disjoint; only
  group ids can clash across scopes, so collisions are **re-ided** (not dropped,
  which would silently lose a whole card). Any task appearing twice is kept by
  the first group that claims it (single-group-per-task invariant).

`projectTaskCardGroups()` already drops tabs whose task isn't visible and
collapses groups with < 2 live tabs, so a global group only renders where ≥ 2 of
its members are visible — no cross-project clutter in single-project views.

The task **detail page** (`web/src/app/app/tasks/[taskId]/page.tsx`) also reads
these groups (for merged-tab prev/next swipe navigation) and was keying by the
same per-project `graphStateKey`. It was switched to `LIST_CARD_GROUPS_SCOPE`
too, so the list and the detail navigation always read the same set — otherwise
opening a task from a specific project would lose merged-group navigation. The
detail page now also hydrates from the sync store snapshot (not just
localStorage), so a cold deep-link to a task URL gets merged-tab navigation
without visiting the list first.

### Follow-up hardening (residual risks closed)
- **Server-side collapse of legacy scopes.** `getTaskCardGroupsPreferences` is
  wrapped by `consolidateTaskCardGroupsScopes` (`web/src/lib/user-preferences.ts`),
  called lazily from the `GET` route. It folds every legacy `projects:<id>` scope
  into `projects:all` in one atomic compare-and-set write and drops the old keys,
  so stored data stays bounded to a single scope (no cruft, no re-folding each
  load, no drift toward `MAX_SYNCED_TASK_CARD_SCOPES`). It is idempotent — a no-op
  once collapsed — and produces the same union the client renders, so read and
  storage agree.
- **Unsynced local merges preserved.** On the client, when the server has no
  global scope yet (older server, or before its collapse runs), the hydrate
  effect folds this device's local `projects:all` cache into the union and lets
  the save effect upload it — instead of overwriting local-only cards. Once the
  server holds an (even empty) global scope it is authoritative, so cards
  dissolved on another device are not resurrected.

## How to avoid next time
- Don't reuse a UI-state scope key across features with different scoping needs.
  A per-project canvas layout and a global list-merge set are different concerns
  even if they visually live in the same list.
- When a feature "works in one filter but not another," suspect the persistence
  **scope key** first — the render path is usually shared and identical.
- When changing a persisted scope, add a consolidation/migration path so
  existing data under the old scope keys is not orphaned.

## Tests
- `web/src/features/tasks/utils/task-card-groups.test.ts`: unit tests for
  `consolidateSyncedTaskCardGroups` (fold across scopes, re-id collisions,
  single-group-per-task).
- `web/src/features/tasks/components/TaskList.test.tsx`: "surfaces a card merged
  under a specific project in the all-tasks view".
- `web/src/app/app/tasks/[taskId]/page.test.tsx`: merged-tab swipe navigation
  seeds the group under the shared `projects:all` scope, and a cold deep-link
  case drives navigation from the synced snapshot alone (no localStorage).
- `web/src/app/api/user-preferences/task-card-groups/route.test.ts`: `GET`
  collapses legacy per-project scopes into `projects:all`, and leaves an
  already-collapsed snapshot untouched.
- `web/src/features/tasks/components/TaskList.test.tsx`: local-only card is kept
  and uploaded when the server has no global scope yet.
- Run: `cd web && pnpm test` (or the files above with vitest).

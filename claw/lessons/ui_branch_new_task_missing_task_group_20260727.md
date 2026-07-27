# Branch-created tasks were not grouped with their source task

## Symptom

Using **New task from this** created and opened the successor task, but the task
list rendered the source and successor as separate cards. Users then had to
manually drag the new task onto the source task to recover the expected
branch-family grouping.

## Root cause

The successor creation path in
`web/src/app/api/tasks/[taskId]/restart/route.ts` persisted the relationship in
task metadata (`continuedFromTaskId` / `successorTaskId`), but it never updated
the existing task-card grouping preference.

Task-card grouping is stored independently as a synchronized user preference.
Consequently, the relationship metadata used by the graph view did not affect
the list view's merged tab cards. The client task store also ignored grouping
state in the restart response, so even a server-side update alone would not
guarantee that the current list immediately selected the successor tab.

## Fix

- Added a pure `mergeTaskIntoSourceCardGroup()` operation that reuses the
  existing drag/drop grouping behavior:
  - create a two-task group when the source is ungrouped;
  - append the successor when the source is already in a group.
- Added `mergeSuccessorTaskCardGroup()` to atomically update the global
  `projects:all` grouping preference with compare-and-set retries.
- The restart route now persists and broadcasts the updated grouping snapshot
  after the successor has been created and dispatched.
- The task store applies the snapshot returned by the restart request so the
  initiating client does not depend solely on WebSocket timing.
- The task list brings the currently selected task's tab to the front when a
  synchronized group arrives.
- Preference synchronization remains best-effort after task creation. Missing
  preference tables or transient preference conflicts cannot turn an already
  dispatched successor into a failed restart response.

## Prevention

When a feature creates a relationship between tasks, verify every persisted UI
projection of that relationship instead of relying on task metadata alone.
For task-card groups specifically:

1. Reuse the grouping mutators so single-membership and ordering invariants stay
   consistent with drag/drop.
2. Update synchronized preferences with compare-and-set semantics because
   multiple devices can edit groups concurrently.
3. Return and broadcast the new snapshot so both the initiating client and
   other connected clients converge immediately.
4. Keep post-creation preference writes non-fatal to avoid duplicate tasks when
   clients retry a request whose core task transaction already succeeded.

## Verification

- Covered new two-task groups and appending to an existing group.
- Covered concurrent preference-write retry without losing another group.
- Covered old self-host schemas where `user_preferences` is unavailable.
- Covered immediate client snapshot application and active-tab selection.
- Ran the complete web suite: 180 test files and 1528 tests passed.

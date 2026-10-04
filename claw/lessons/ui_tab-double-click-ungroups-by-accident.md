# Double-clicking a task tab ungrouped it by accident

## Symptom
In the task list, double-clicking a tab on a merged tab card removed that task
from the group. Users switching tabs with quick clicks kept dissolving groups
without meaning to.

## Root cause
A destructive action (un-merge) was bound to `onDoubleClick` on the same tab
element whose single click is the most common action (switch tab). Two quick
switches register as a double-click.

## Fix
- Removed the tab `onDoubleClick` handler in `TaskList`.
- `TaskItem` takes an optional `onUngroup` prop. `TaskList` passes it only
  for the card shown inside a tab group, and the card's ⋯ actions menu then
  shows an **Ungroup** button that ejects that task.
- Tests: `TaskList.test.tsx` checks that a double-click no longer unmerges and
  that the menu action does. `TaskItem.test.tsx` checks the button appears only
  when grouped.

## How to avoid next time
Don't bind destructive or structural changes to double-click (or any gesture
that a fast repeat of the primary action can trigger). Put them behind an
explicit menu item.

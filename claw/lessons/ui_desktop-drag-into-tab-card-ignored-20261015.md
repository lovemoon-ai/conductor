# Desktop: a third task can't be dragged into a tab card

## Symptom
On desktop, dragging one task card onto another created a tab card. Dragging a third task onto that tab card did nothing: the card didn't highlight and nothing merged. On mobile the same gesture worked.

## Root cause
The mouse merge drag in `TaskList.tsx` is driven by `onPointerMove` / `onPointerUp` handlers attached only to plain task rows (`data-task-item-wrapper`). Nothing captured the pointer, so each event went to the element under the cursor and reached the shared handler only by bubbling through *some* task row.

- Dropping onto another task row worked because that row also has the handlers.
- A tab card (`data-task-tab-card`) has no row handlers. While the cursor was over it, moves never updated the drop target and the `pointerup` was lost, so `addTaskToGroup` never ran.

Mobile was unaffected: touch events always target the element where the touch started, and touchmove is handled on `window`.

## Fix
When the drag activates, call `setPointerCapture` on the dragged row. Every later move/up event is then delivered to the dragged row's handlers wherever the cursor is, and the drop target is still found by hit-testing coordinates.

Regression test: `TaskList.test.tsx` › "merges a third card into an existing tab card with a mouse drag". It sends events to the element under the pointer unless capture was requested, which matches browser behaviour.

## How to avoid next time
- A pointer-driven drag must capture the pointer (or listen on `window`) as soon as it activates. Don't rely on the cursor staying over elements that happen to carry the same handlers.
- When some list rows get handlers and others don't, test the gesture against each row type. Tests that fire every event on the source element hide this whole class of bug.

# Mobile task-detail swipe ignores the task's tab-card group

## Symptom
On the mobile chat page, swiping the title left/right of a task that belongs to a
merged tab card jumped to the neighbouring list rows instead of the other tabs of
the same card, so tabs other than the active one could never be reached by swiping.

## Root cause
`buildTaskListNavigation` flattens every tab card into a single list item (its
active tab) and the detail page anchored a grouped task to that item, so prev/next
always came from the list rows.

## Fix
`buildTaskListNavigation` also returns `groupTasksByTaskId` (visible tabs, tab
order). The detail page uses it for grouped tasks and cycles with wrap-around
(last → first, first → last); ungrouped tasks keep stepping through list rows.

## Avoid next time
When a list has a nested structure (cards with tabs), decide explicitly which level
each navigation gesture walks, and test from a non-first/non-active member.

# ui: "New task from this" creates a successor but does not open it

## Symptom
Using the "New task" swipe action on a task (BUG-R5-02) creates a successor
task and groups it, but the UI stays on the SOURCE task. The user expects the
newly created successor to become the selected/open task.

## Root cause
`RestartTaskControls` (`web/src/features/tasks/components/RestartTaskControls.tsx`)
only called `navigateToTask(result.task.id)` on a successful `new_task`
restart, which updates the URL (`?taskId=successor`) but nothing else.

The Tasks page (`web/src/app/app/tasks/page.tsx`) computes
`effectiveSelectedTaskId` by preferring the LOCAL React state
`selectedTaskId` over the URL `requestedTaskId`, and a reconciler effect even
rewrites the URL back to match the local selection. Since `selectedTaskId`
still pointed at the source task (which remains visible/grouped), the
URL-only navigation was immediately overridden and the successor was never
selected.

The normal Create flow works because `CreateTaskDialog` calls
`onCreatedTask(task.id)` wired to the page's `handleTaskCreated`, which sets
BOTH the local `selectedTaskId` AND the URL. The successor flow omitted this
local-state update.

## Fix
Mirror the working create flow:
1. Added an optional `onCreatedTask?: (taskId: string) => void` prop to
   `RestartTaskControls`. In `handleRestart`, after a successful `new_task`
   result, prefer it: `if (onCreatedTask) onCreatedTask(result.task.id); else
   navigateToTask(result.task.id)`. Behavior is unchanged when the prop is
   absent (fallback to URL navigation).
2. Threaded it at the render site in `TaskItem.tsx`:
   `onCreatedTask={onOpenTask}`. `onOpenTask` is the page's `handleSelectTask`,
   which sets both the local `selectedTaskId` and the URL.

The source-task-not-removed grouping behavior is untouched; only the selection
after creation changed.

## How to avoid
When navigation depends on client state that can override the URL, do not rely
on URL mutation alone. Route "select this entity" intents through the same
handler the rest of the page uses to set local selection state (here
`onOpenTask` / `handleSelectTask`), so a reconciler effect cannot undo the
navigation. Compare against the known-good sibling flow (CreateTaskDialog +
`onCreatedTask`) when a new flow "creates but doesn't open".

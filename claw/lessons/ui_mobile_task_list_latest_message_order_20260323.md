# ui: mobile task list lost "new message moves task to top" ordering after leaving the list view (2026-03-23)

## Symptoms
- In the task list UI, tasks with new messages are supposed to move to the top.
- Desktop list-pane mode behaved correctly while the list stayed mounted.
- Mobile users could open a task, receive new messages, then return to the task list and see the order reset as if the latest-message task had not been promoted.

## Root Cause
- Websocket updates already moved active tasks to the front in the client store.
- But mobile navigation uses a separate task detail route, so returning to `/app/tasks` remounts the list and refreshes data from `/api/tasks`.
- That API response was sorted by `createdAt desc`, not by latest activity.
- So the mobile refresh overwrote the client-side promoted order with creation-time order, effectively removing the "new message goes to top" behavior on mobile.

## Fix
- Change `/api/tasks` list ordering to sort by latest activity time:
  - `updatedAt desc`
  - then `createdAt desc` as a stable fallback
- Add an API regression test proving that an older task with newer activity still comes before a newer-but-idle task.

## Prevention
- When desktop and mobile use different navigation lifecycles, keep list ordering semantics in the shared API instead of relying only on in-memory client state.
- Add regression coverage for any task list behavior that must survive remounts, route changes, or reconnect-triggered refetches.

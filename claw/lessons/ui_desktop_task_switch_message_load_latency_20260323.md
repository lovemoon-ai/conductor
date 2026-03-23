# Desktop task switch message load latency

## Symptom
- In desktop task split-pane mode, switching between tasks felt slow.
- Users often saw the right detail pane spinner for too long before chat history appeared.
- Reopening previously viewed tasks could still feel slow because history was fetched again.

## Root cause
- `TaskDetailPane` blocked rendering on `fetchTask(taskId)` even when task list data already existed locally.
- `/api/tasks/[taskId]` redundantly queried and returned full `messages`, but the task store ignored that payload.
- `ChatView` then performed a second message-history request, causing duplicate history loading work.
- The messages API change initially introduced a compatibility regression by paginating the default array response; this would have broken mixed-version fire backfill and diagnose fallback on long histories.
- Hydrated chat cache also needed reconnect invalidation to avoid stale history after websocket gaps.

## Fix
- Render desktop detail panes immediately from task-list/store data and refresh task detail in the background.
- Remove redundant `messages` payloads from `/api/tasks/[taskId]`.
- Add explicit paginated history loading for the web chat while keeping the default `/messages` array response fully backward compatible.
- Invalidate hydrated chat caches on websocket reconnect and force-refresh the active task history.
- Improve desktop task UX with card reorder animation, composer autofocus, and recent-message recall.

## How to avoid next time
- When adding pagination to an existing endpoint, preserve the default wire format and semantics unless all old consumers have been migrated.
- For split-pane UX, avoid blocking the detail pane on refresh-only data when list data is already sufficient for first paint.
- Any local caching of streamed history should have a reconnect recovery path.
- Mixed-version compatibility for message history endpoints should be covered by regression tests before release.

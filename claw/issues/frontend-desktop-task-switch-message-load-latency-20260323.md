# Issue: Frontend desktop task switch message load latency

## Problem / Context

In desktop `TaskList` split-pane mode, switching between tasks feels slow, especially for tasks with longer message history.

The current detail loading path does extra work:
- `TaskDetailPane` blocks the right pane on `fetchTask(taskId)` before rendering detail content
- `/api/tasks/[taskId]` loads and returns full `messages`, even though the tasks store does not consume them
- `ChatView` then issues a second request to `/api/tasks/[taskId]/messages`
- Re-opening an already viewed task still re-fetches the full message history

This creates avoidable latency exactly on the high-frequency desktop task-switch path.

## Goal

Reduce perceived and actual latency when switching tasks in desktop split-pane mode with the smallest safe change set.

## Acceptance Criteria

- [ ] Switching tasks in desktop split-pane mode no longer waits on a blocking detail spinner when task list data is already present
- [ ] `/api/tasks/[taskId]` no longer queries or returns full `messages`
- [ ] Already viewed chat tasks do not re-fetch full message history on every re-open
- [ ] Existing task detail behavior for standalone `/app/tasks/[taskId]` remains correct
- [ ] Existing websocket-driven message updates continue to work

## Scope

- In scope
  - remove redundant message payload from task detail GET
  - make `TaskDetailPane` render from list/store data first and refresh detail in background
  - add a minimal message-cache short circuit for chat history fetches
- Out of scope
  - message pagination / cursor APIs
  - chat virtualization
  - websocket protocol changes
  - major task detail store refactor

## Plan / Tasks

- [ ] Remove `messages` query/response from `web/src/app/api/tasks/[taskId]/route.ts`
- [ ] Update `TaskDetailPane` so existing task data can render immediately while `fetchTask()` refreshes in background
- [ ] Add minimal cache hit behavior to chat message fetching to avoid repeated full reloads for previously opened tasks
- [ ] Add/update focused tests for the new detail and chat behavior
- [ ] Run focused verification on the affected task detail / chat flows

## Risks / Dependencies

- If a task is opened directly without prior list hydration, the detail page still needs a loading state until the task arrives
- If cache short-circuiting is too aggressive, stale history could persist; websocket updates mitigate this for active tasks
- This issue improves first interaction latency, but very large first-time message histories will still need pagination later

## Links

Related code:
- `web/src/app/api/tasks/[taskId]/route.ts`
- `web/src/components/conductor/tasks/TaskDetailPane.tsx`
- `web/src/components/conductor/chat/ChatView.tsx`
- `web/src/lib/conductor/stores/chat.ts`

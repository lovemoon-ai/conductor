# Symptom

- PTY tasks exposed the Share action in the mobile swipe menu.
- The PTY task action menu should only allow deletion, because sharing is only supported for AI task detail pages.

# Root Cause

- `TaskItem` used a fixed right-side action layout and always rendered the Share button.
- The restart action was already gated by task type, but the share action was not.

# Fix

- Gate the Share action behind `taskType === 'ai_task'`.
- Calculate the right swipe width from the number of visible action buttons.
- Updated the PTY task swipe-menu test to assert that only Delete is shown.

# How To Avoid Next Time

- Treat swipe menu width and button rendering as one state derived from the same action list.
- Add task-type matrix tests whenever task actions differ between AI and PTY tasks.

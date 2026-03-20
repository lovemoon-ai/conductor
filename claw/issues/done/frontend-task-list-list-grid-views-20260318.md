# Issue: Frontend task list - list/grid multi-view & task card redesign

## Problem / Context

Currently `TaskList` only has a single list view:
- Suitable for linear browsing, but not suitable for card scanning and widescreen browsing scenarios
- There is room for improvement in information levels such as task status, daemon, backend, unread, etc.
- If the app shell becomes more dashboard-like in the future, the task list will also need to provide a more flexible view mode.
RFC has clarified that Task List should support two presentation methods, `list` / `grid`, and keep the core operations consistent.

## Goal

Upgrade the Task List to a task workspace that supports multi-view switching, while improving the information level and status expression of task items.

## Acceptance Criteria

- [ ] Task List supports `list` / `grid` two view switching
- [ ] The two views share core capabilities such as filtering, refreshing, batch selection, and deletion.
- [ ] View preferences can be persisted, or have clear default policies by device/width
- [ ] Task item status, daemon, backend, unread, time and other information levels are better than the current version
- [ ] Empty state and loading state adapt to two view modes

## Scope

- In scope
  - task list toolbar / view switch
- list view refactoring
- grid view design and implementation
- Optimized task card information level
- View state persistence
- Out of scope
- task detail chat page
- task creation dialog
- Modification of complex sorting rules (unless necessary for view switching)

## Plan / Tasks

- [ ] Define task list toolbar structure (count / filter context / refresh / view switch)
- [ ] Reconstruct the item hierarchy and grouping expression of list view
- [ ] Design and implement grid view
- [ ] Abstract shared task item data model to avoid repeated drift of list/grid logic
- [ ] Persisting user view preferences
- [ ] Validate bulk selection, delete, unread, empty status are clearly available in both views

## Risks / Dependencies

- Depends on card / empty state / confirm dialog primitives in foundation issue
- If list/grid implements too much logic respectively, it will be easy to fork in subsequent maintenance.
- If the default view policy is unclear, users may have the feeling of "changing every time they open it"

## Links

- RFC: `claw/rfc/frontend-design-refresh.md`
Related code:
- 
- `web/src/app/app/tasks/page.tsx`
  - `web/src/components/conductor/tasks/TaskList.tsx`
  - `web/src/components/conductor/tasks/TaskItem.tsx`
  - `web/src/components/conductor/tasks/TaskStatusBadge.tsx`

# Issue: Issue linked task remains openable after kill

## Problem / Context

An issue can currently open only its `activeTask`.

In the current implementation, issue APIs include only tasks whose status is in the active set (`init`, `running`, `killing`, `unknown`). Once the linked task becomes `killed` or `completed`, the issue response no longer carries that task as `activeTask`, and the Issue card loses its `Open task` entry point.

This creates an inconsistent experience:
- the task record still exists after a kill
- the task usually still keeps `task.issueId`
- the user can still open the task directly from the Tasks page or URL
- but the Issue that created or owned the task can no longer open it

The desired behavior is: if an Issue has ever linked to a task, killing that task should not remove the Issue-level entry point to open it.

## Goal

Keep the latest linked task openable from the Issue UI after the task is killed, while preserving the existing `activeTask` behavior for live task state.

## Acceptance Criteria

- [ ] When an Issue-linked task transitions to `killed`, the Issue still exposes an entry point to open that task
- [ ] When an Issue-linked task transitions to `completed`, the Issue still exposes an entry point to open that task
- [ ] `activeTask` semantics remain unchanged and still represent only live/active tasks
- [ ] The Issue UI clearly handles the case where the linked task is historical rather than active
- [ ] If the task has been deleted, the Issue does not show a broken link
- [ ] Issue list and issue detail responses are consistent about which linked task metadata they return

## Scope

- In scope
  - add a non-active linked-task field to Issue API responses, such as `latestTask`, `lastTask`, or `linkedTask`
  - update frontend Issue types and normalization to consume the new field
  - update Issue card/list rendering so killed or completed linked tasks can still be opened
  - define precedence between `activeTask` and the non-active linked task field
  - add focused tests for killed/completed Issue-linked task visibility
- Out of scope
  - keeping deleted tasks openable
  - full Issue-to-task history UI
  - task restore / undelete flows
  - changing task deletion semantics

## Plan / Tasks

- [ ] Define the Issue API shape for a persistent linked-task reference without overloading `activeTask`
- [ ] Update Issue queries/serialization to return both `activeTask` and the latest linked task when appropriate
- [ ] Update shared/frontend Issue types and store normalization
- [ ] Update `IssueCard` and related Issue views to render the correct open action for active and killed/completed tasks
- [ ] Add API and frontend tests covering killed, completed, and deleted linked-task cases

## Risks / Dependencies

- Returning only "latest linked task" may be ambiguous if an Issue has multiple historical tasks; precedence rules need to be explicit
- Reusing `activeTask` for historical tasks would blur semantics and likely break existing assumptions
- The API should avoid returning deleted-task references or stale links
- If restart creates successor tasks for the same Issue, the selected linked task should match user expectation

## Links

Related code:
- `web/src/app/api/issues/shared.ts`
- `web/src/app/api/issues/route.ts`
- `web/src/app/api/issues/[issueId]/route.ts`
- `web/src/lib/issues/config.ts`
- `web/src/lib/issues/serialization.ts`
- `web/src/shared/types/index.ts`
- `web/src/features/issues/store.ts`
- `web/src/features/issues/components/IssueCard.tsx`

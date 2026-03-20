# Issue: Frontend design foundation - tokens & feedback primitives

## Problem / Context

`web/` currently has a batch of reusable styles, but it is still in the stage of "it can work, but it has not formed a formal system":
- `web/src/app/globals.css` defines some basic variables, but the semantic layer is not complete yet.
- Ununified variable references such as `var(--card)` and `var(--text)` can still be seen in the code.
- The page feedback method is inconsistent, and many key processes still use the native `alert()` / `confirm()`.
- If you change the page directly in the future without adding the base layer first, it is easy to continue to produce new style drift.
This issue corresponds to the basic part of the RFC and is used to provide a unified prerequisite for subsequent sidebar, task list, settings, and landing modifications.

## Goal

Establish a set of front-end design infrastructure that is lightweight but clear enough:
- Formal design tokens
- Unify basic component style constraints
- Unified feedback primitives (toast / confirm dialog / empty state / section card)

## Acceptance Criteria

- [ ] `globals.css` has clear primitive / semantic token layering
- [ ] Clean or replace existing drift variable references (such as `--card`, `--text`)
- [ ] Added unified `Toast` / `ConfirmDialog` / `EmptyState` / `SectionCard` basic components
- [ ] No new native `alert()` / `confirm()` calls will be added in the app
- [ ] At least 1
- 2 existing pages have completed access to new feedback primitives to verify availability.

## Scope

- In scope
- Color, surface, text, border, radius, shadow, motion token normalization
- Basic buttons/input boxes/cards/pop-up window semantic constraints
- Global toast and confirm dialog basic capabilities
- Empty state, section card and other reusable containers
- Out of scope
- Landing completely reworked
- Final visual solution for Task List/Sidebar
- Transformation of Terminal's internal rendering logic

## Plan / Tasks

- [ ] Audit current token, class and variable usage
- [ ] Design and implement token naming scheme
- [ ] Clean up drift variable references in `globals.css` and high frequency components
- [ ] Implement `Toast` component and global mounting method
- [ ] Implement `ConfirmDialog` and provide a unified style for dangerous operations
- [ ] implement `EmptyState` / `SectionCard`
- [ ] First replace a batch of native pop-up calls in existing pages and verify that the new primitives are sufficient to support subsequent work.

## Risks / Dependencies

- If the token naming is over-designed, it will increase the implementation cost.
- If feedback primitives are accessed too late, subsequent page modifications will still use the old model.
- This issue is the basic dependency of multiple subsequent UI issues

## Links

- RFC: `claw/rfc/0015-frontend-design-refresh.md`
-Related codes:
- `web/src/app/globals.css`
  - `web/src/components/conductor/common/Dialog.tsx`
  - `web/src/components/conductor/tasks/TaskList.tsx`
  - `web/src/components/conductor/tasks/TaskItem.tsx`
  - `web/src/components/conductor/projects/ProjectItem.tsx`

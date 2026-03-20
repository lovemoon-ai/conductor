# Frontend priority backlog (evaluated on 2026-03-19)

## Purpose

Based on the current code implementation, re-evaluate the completion status of the `claw/issues/frontend-*` proposal and reschedule the unfinished front-end issues.

## Completed and moved to `claw/issues/done/`

The following issue has covered major acceptance items in the current code and has been moved to `claw/issues/done/`:
1. `done/frontend-design-foundation-tokens-and-feedback-20260318.md`
2. `done/frontend-create-task-dialog-productization-20260318.md`
3. `done/frontend-task-detail-chat-status-20260318.md`
4. `done/frontend-task-list-list-grid-views-20260318.md`

## Still open

### P0

#### 1. `frontend-app-shell-dashboard-sidebar-20260318.md`

**Why now**
- `/app` now has the basic structure of sidebar + page header, but sidebar is still mainly a first-level navigation.
- The workspace layering (workspace area, main navigation area, auxiliary area, bottom account area) required in the issue has not yet been fully implemented.
- This is the one that has the greatest impact on the overall workbench experience among the remaining front-end proposals.
### P1

#### 2. `frontend-collapsible-sidebar-interaction-20260318.md`

**Why here**
- The current code already supports sidebar expansion/collapse, `localStorage` persistence and basic aria label.
- But the folded tooltip / equivalent can understand feedback, and the complete usability details are not yet completely closed.
- This item depends on the final structure of sidebar redesign, so it is placed after app shell.
#### 3. `frontend-settings-account-billing-runtime-20260318.md`

**Why here**
- The current Settings page already has API token, daemon, build info, session and other blocks, but it is not yet the Account / Runtime / Billing / Build information architecture in the issue target.-Billing/subscription capabilities are still not integrated into the main Settings page.
- The foundation has been completed and can be directly promoted based on `SectionCard`, toast, confirm and other infrastructure.
### P2

#### 4. `frontend-landing-docs-brand-alignment-20260318.md`

**Why later**
- The current homepage still mixes post-login token/CLI information, and logged-in access to `/` will not directly converge to the main app link.
- The packaging layer of `docs` is still thin, and `web/src/app/docs/layout.tsx` has not yet assumed the responsibility of brand unification.
- Compared with the main workflow in the app, this is the least disruptive to daily logged-in users, and it is more reasonable to continue it later.

## Summary of current evaluation

- **Completed**: foundation, create task, task detail, task list.
- **Partially completed but not closed**: app shell, collapsible sidebar.
- **Obviously incomplete**: settings IA refresh, landing/docs brand alignment.

## Suggested next phase

1. `frontend-app-shell-dashboard-sidebar-20260318.md`
2. `frontend-collapsible-sidebar-interaction-20260318.md`
3. `frontend-settings-account-billing-runtime-20260318.md`
4. `frontend-landing-docs-brand-alignment-20260318.md`

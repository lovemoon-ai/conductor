# Issue: Frontend app shell - dashboard sidebar redesign

## Problem / Context

The current desktop layout of `/app` already has basic navigation capabilities, but the overall layout is more like the traditional backend of "left menu + right page" rather than a continuously working dashboard/workspace:
- `Sidebar.tsx` is mainly responsible for first-level navigation, and the information density and level are relatively limited.
- The boundaries of responsibilities between `Header.tsx` and `Sidebar.tsx` are not clear enough.
- After entering the app, users lack the overall sense of "this is an AI orchestration workspace".
RFC has clarified that the app shell should be upgraded to the dashboard skeleton. This issue is responsible for the design and implementation of the skeleton itself.

## Goal

Refactor the `/app` desktop shell to make the sidebar a workbench navigation skeleton more like a dashboard.

## Acceptance Criteria

- [ ] `/app` desktop shell has a clearer division of sidebar / content / header
- [ ] The sidebar is upgraded from simple navigation to workspace style structure
- [ ] The sidebar supports logo/workspace area, main navigation area, auxiliary area, bottom account area and other levels
- [ ] Current activation state, count/status information, hover/focus feedback is clearer than the status quo
- [ ] New shell is compatible with existing Tasks / Projects / Settings pages

## Scope

- In scope
- `/app` shell layout reconstruction on desktop
- Sidebar information level, structure and visual transformation
- Reorganized the responsibilities of Header and Sidebar
- Navigation items, status points, badges, and section containers are unified
- Out of scope
- Sidebar folding persistence and detailed interaction (separate issue)
- Task List list/grid view switching
- Landing / Docs

## Plan / Tasks

- [ ] Sort out the responsibility boundaries of sidebar, header, and main in the existing app shell
- [ ] Design a new sidebar information structure
- [ ] Transform `Sidebar.tsx`, `app/layout.tsx`, necessary header structure
- [ ] Introduce dashboard style auxiliary information (active state / count / status / grouped nav)
- [ ] Verify visual consistency in Tasks / Projects / Settings
- [ ] Supplement basic test or screenshot baseline

## Risks / Dependencies

- Rely on tokens / section primitives in design foundation issue
- If the responsibilities of header and sidebar are not clearly defined in advance, duplicate navigation may easily occur.
- Excessively increasing sidebar content may harm information clarity

## Links

- RFC: `claw/rfc/frontend-design-refresh.md`
Related code:
- 
- `web/src/app/app/layout.tsx`
  - `web/src/components/conductor/layout/Sidebar.tsx`
  - `web/src/components/conductor/layout/Header.tsx`
  - `web/src/components/conductor/layout/MobileNav.tsx`

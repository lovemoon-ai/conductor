# RFC: Conductor Web Frontend Design Refresh

## Status

Proposed

## Owner

TBD

## Date

2026-03-18

## Summary

This RFC proposes a round of product experience-oriented design upgrades to the `web/` front-end. The goal is not to "partially complement the style", but to establish a clearer visual direction for the Conductor brand and unify the design language, information architecture and interactive feedback methods of the three types of interfaces: landing, app, and docs.
Core idea:- Choosing a clear visual direction for Conductor rather than remaining stuck in a generic SaaS console style.- Split the unlogged home page and the logged in workbench to reduce information confusion on the home page.- Establish formal design tokens and basic component specifications to replace some of the current scattered styles and variable inconsistencies.- Reconstruct the app navigation skeleton, focusing on upgrading the sidebar design to make it closer to the modern dashboard.- Prioritize redoing high-frequency interfaces: Task List, Create Task, Task Detail Chat, Settings.- Added multi-view switching capability to the task list, supporting two presentation methods `list` / `grid`.- Replace native `alert()` / `confirm()` with unified toast / dialog / inline feedback to improve product completion.
## Context

Currently, the `web/` front-end already has good functional integrity and basic consistency, but there are still obvious shortcomings in brand recognition, information architecture and detailed design.
### Current Issues
1. **Lack of clear aesthetic direction**- The current overall look is more like a "warm-color SaaS backend" and does not reflect Conductor's brand semantics (commanding, orchestrating, and controlling multiple AI workers).- Landing, app, and docs are independent of each other, and the experience is not unified enough.
2. **Mixed responsibilities on the home page**- `web/src/app/page.tsx` is also responsible for: brand display, login guidance, OAuth bootstrap, CLI installation, API token, subscription status, invitation rewards and other responsibilities.- Unlogged and logged in scenes are mixed on one page, resulting in unclear main line of the page.
3. **The design token and semantic layer are not clean enough**- `web/src/app/globals.css` already has variables such as `--ink` / `--paper` / `--panel` / `--border`.- But there are still unresolved variable references such as `var(--card)` and `var(--text)` in the code.- The component layer lacks formal semantic token and component token conventions.
4. **Interactive feedback is still engineering-oriented**- Still using browser native `alert()` / `confirm()`:     - `web/src/components/conductor/tasks/TaskList.tsx`
     - `web/src/components/conductor/tasks/TaskItem.tsx`
     - `web/src/components/conductor/tasks/CreateTaskDialog.tsx`
     - `web/src/components/conductor/projects/ProjectItem.tsx`
     - `web/src/components/conductor/chat/ChatView.tsx`
     - `web/src/app/(main)/subscription/page.tsx`
- This will directly reduce the quality of the product.
5. **High-frequency processes can also be more productized**- The task type in `CreateTaskDialog.tsx` uses checkbox to express mutually exclusive choices, which does not conform to the cognitive model.- Task List/Settings is still biased towards "card stacking", and the information level and operation priority are not obvious enough.- The app sidebar is still more like the traditional left navigation, not like the workbench skeleton of a modern dashboard.- Task List currently only has a single list view, which cannot adapt to the different needs of users in the two task management scenarios of "scan status" and "browse cards".
6. **Typography lacks branding**- A clear font strategy has not yet been established; the hierarchy of titles, body text, and description text is not strong enough.- This makes the page usable, but not "memorable" enough.
## Goals

- Establish a clear, stable, and scalable visual direction for Conductor Web.- Unify the design language of landing, app, and docs.- Clarify the boundaries of responsibilities between the home page and the workbench, and optimize the information architecture.- Establish formal design tokens and base component specifications.- Reconstruct the app sidebar to give it a stronger dashboard feel and better information hierarchy.- Add sidebar folding interaction, for experience please refer to the workspace navigation method of chatgpt.com.- Prioritize improving the interaction quality of task creation, task list, task details chat, and settings page.- Provide list / grid multi-view switching capabilities for task lists.- Replace native browser pop-ups with consistent feedback mechanisms (toast / dialog / inline status).- Improve overall brand recognition and product completion without significantly increasing implementation complexity.
## Non-Goals

- This RFC does not involve changes to the backend protocol, database schema or task execution model.- This RFC does not seek to rewrite all front-end pages at once; it adopts a phased and progressive transformation.- This RFC does not require the introduction of heavyweight design system frameworks.- This RFC does not force the core interaction of Terminal to be redone in this round, but only requires that its style be consistent with that of peripheral containers.
## Options Considered

### Option A: Only partial visual polish
**practice**- Keep existing information architecture unchanged.- Local color adjustment, rounded corners, shadows, button and card styles.
**advantage**- Lowest implementation cost.- Little disruption to existing code.
**shortcoming**- Unable to solve the problem of mixed responsibilities on the home page.- Cannot cure the visual inconsistency of landing / app / docs.- The improvement in brand recognition is limited, and it is easy to become a "more refined but still ordinary" background.
### Option B: Completely redo the front end at once
**practice**- At the same time, redo the homepage, application pages, document pages, and component system.
**advantage**- Theoretically the most unified vision.- Complete specifications can be created at once.
**shortcoming**- High risk, long cycle.- Easily blocks existing feature development.- Regression testing and launch costs are high.
### Option C: Phased design upgrade (recommended)
**practice**- First determine the visual direction and token.- Split the homepage responsibilities again.- Finally, give priority to transforming high-frequency core pages and gradually unify docs.
**advantage**- Risks are controllable.- Deliver visible benefits at every stage.- Facilitates parallelism with current feature iterations.
**shortcoming**- During the transition period, new and old styles will coexist.- Needs stricter execution constraints to avoid doing half the work.
## Proposed Design

### 1. Visual direction
Choose a direction that better fits the meaning of the Conductor brand: **Orchestral Control Room**.
Design keywords:- Precise control- Arrangement and rhythm-Console/podium/workbench- Professional but not cold- Highly identifiable without being overly decorative
Visual strategy suggestions:- Use a dark or neutral background color as the main console scene.- Keep warm orange as the brand accent color, but reduce the familiarity of the "generic SaaS gradient button".- Introduce a small number of background themes related to "rhythm/arrangement/waveform/track/line" and use them for the homepage hero, empty state, and section header instead of covering them all over the site.- Control the density of motion effects in the app, focusing on "clear + professional"; allow stronger brand expression in the landing.
### 2. Information architecture adjustment
#### 2.1 Not logged in to the home page
If you are not logged in to the home page, you are only responsible for:- Brand description- Value proposition- Main CTAs (Login / Get Started / Docs)- Lightweight function display
No longer carry the following content directly on the home page:- API token management- Subscription status management- Invitation reward details- Workbench information of logged in users
#### 2.2 Logged in
When a logged-in user accesses `/`, he or she is redirected to `/app/tasks` or a separate `/app/dashboard` in the future.
#### 2.3 Settings and account domain integration
Consolidate the following content into Settings / Account / Billing within the app:- API token
- Subscription
- Invite / referral
- Build info
- Connected daemons

#### 2.4 App shell upgraded to dashboard skeleton
The `/app` area is no longer just a basic background layout of "left navigation + right content", but has been upgraded to a more explicit dashboard shell:- The sidebar is responsible for navigation, context switching, and key secondary information entry.- The main content area is responsible for the page title, operation area, filters, and main data view.- The mobile version continues to retain the bottom navigation, but the desktop version gives priority to enhancing the workbench feel of the sidebar.
Target effect:- After the user enters the app, they immediately perceive that this is a continuously used AI orchestration workspace, rather than a collection of several pages.- Tasks, projects, settings are more like different perspectives in the same workbench in the information architecture.
### 3. Design Tokens system
Based on the existing `globals.css`, complete and standardize the three-layer token:
#### 3.1 Primitive tokens
- color
- radius
- shadow
- spacing
- motion duration / easing

#### 3.2 Semantic tokens
- `surface.default`
- `surface.panel`
- `surface.subtle`
- `text.primary`
- `text.secondary`
- `text.inverse`
- `border.default`
- `accent.default`
- `accent.hover`
- `success` / `warning` / `danger`

#### 3.3 Component tokens
- button
- input
- card
- dialog
- nav item
- chat bubble
- status badge

Also clean up variable reference inconsistencies:- Replace `var(--card)` with the official surface token- Replace `var(--text)` with the official text token- Unify the source and semantic definition of `bg-panel` / `bg-paper` / `text-muted` / `border-border`
### 4. Typography solution
- Add more recognizable display fonts for landing hero and section title.- A stable and easy-to-read text system for internal use within the app.- Establish clear title levels and copy styles:  - hero
  - page title
  - section title
  - card title
  - label / caption / helper text
- The docs also use the same set of text and title level logic to avoid the break between Nextra's default style and the app.
### 5. Basic interactive feedback system
Added unified feedback mode:- toast: success / failure / light reminder- confirm dialog: delete, overwrite, dangerous operations- inline error: form verification, loading failed- empty state: no tasks, no daemon, no messages- loading state: skeleton or lightweight spinner + copywriting
Require:- Gradually replace all `alert()` / `confirm()`- No more new native pop-up calls will be added
### 6. App Sidebar / Navigation design
The sidebar will be one of the core features of this round of design upgrades, focusing on solving the problem of "like the backend, but not like the dashboard".
#### 6.1 Sidebar Goals- More like dashboard/workspace than a simple menu bar.- Let users understand the current context in fewer clicks.- Remains available in both expanded and collapsed states.
#### 6.2 Suggested structure- Top: Brand/workspace logo- Central main navigation: Tasks / Projects / Settings (expandable in the future Agents / Billing)- Middle sub-section: current filter, recent projects, quick entry or status summary- Bottom: Account entrance, theme switching, auxiliary operations
#### 6.3 Folding interaction- Added collapsible sidebar on desktop.- Collapse cross-reference chatgpt.com:- Display icon + label + local context when expanded- Keep icon, hover tooltip, and current selection when folded- The switching animation is short and restrained, and does not affect the stability of the main content area.- The collapsed state is recommended to be persisted to local storage so that users can maintain their personal preferences.
#### 6.4 Visual and interactive requirements- The current activation item is more explicit than the existing implementation, but avoids an overly gradient button feel.- Support dashboard-style auxiliary information such as unread / count / status dot.- The division of responsibilities with the page header is clearer, so that the header and sidebar are not like navigation bars.
### 7. Priority for high-frequency page modification
#### P0：Task List
- Strengthen the grouping or visual distinction of Running / Pending / Completed- Improve the level of task status, daemon, backend, and unread mark- Improved product feel for batch selection/deletion- The empty state expresses the next action more clearly- Added `list` / `grid` view switching:- `list` is suitable for high-density scanning, batch operations, and status comparison- `grid` is suitable for stronger visual distinction, card-based browsing, mobile or widescreen browsing- View switching state should be persisted and allow default values ​​to be selected by page width- Both views should share core capabilities such as filtering, sorting, selection, and deletion, rather than creating two sets of inconsistent interactions.
#### P0：Create Task Dialog
- Changed task type from checkbox to radio card- Display the usage description of AI Task / PTY Task- Clarify the relationship between daemon available status and backend selection- Improve submission process and error message quality
#### P1：Task Detail Chat
- Maintain existing scroll resume and draft capabilities- Improve the hierarchical relationship of message area, runtime status bar, and input box- Changed "Session not ready" feedback from `alert()` to inline status or toast
#### P1：Settings
- Split into clearer sections: Account / Runtime / Billing / Build- Improve the discoverability of main operations (copy token, view daemon, enter subscription)- Relegate Build info to the auxiliary information level
#### P2：Landing / Docs
- Provide stronger brand narrative and hero design for landing- Unify the fonts, spacing, color swatches, and code block styles of docs
### 8. Animation principle
- landing: can have more obvious staged reveal, spotlight, background animation effects- app: Based on the principle of short, stable and less, focus on strengthening hover / focus / state transition- The folding/expanding of the sidebar is the key animation scene of the app shell and should be focused on polishing.- All animation effects should give priority to serving the sense of hierarchy and status feedback, rather than pure decoration.
### 9. Accessibility Requirements
- Ensure that the contrast of key text under dark/light themes meets the standard- Keyboard accessible: dialog, menu, task operations, settings key buttons- Sidebar collapse button, tooltip, and view switching button must support keyboard and aria semantics- Clarify focus ring style- Dangerous operations must have clear documentation and secondary confirmation
## Proposed Execution Plan

### Phase 0: Audit and Specification Freeze- Output visual direction instructions- Output token naming rules- Inventory existing components and variable references- List the modes that are prohibited from adding new ones: `alert()` / `confirm()` / Temporary variable name / Undefined semantic color
### Phase 1: Infrastructure- Clean up the token definition in `globals.css`- Added unified `Toast` / `ConfirmDialog` / `EmptyState` / `SectionCard`- Unify buttons, input boxes, cards, and pop-up window styles- Establish basic component conventions for app shell / sidebar / view switch
### Phase 2: Core application page- Refactor app sidebar and dashboard shell- Rework `TaskList`- Rework `TaskList`- Optimize `TaskDetail Chat`- Optimize `TaskDetail Chat`
### Phase 3: Entrance and brand layer- Split the non-login home page and the login workbench entrance- Refactor landing hero, section structure and CTA- Unify docs packaging layers and visual styles
### Phase 4: Closing and Constraints- Supplementary testing and screenshot baseline- Supplementary design and implementation documentation- Enforce compliance with token/component specifications in subsequent front-end iterations
## Risks

- During the period when old and new styles coexist, the vision may become even less unified in the short term.- If you create the page first without creating the token first, local patches will easily appear again.- If the landing and app are significantly modified at the same time, the review cost will become higher.- If component constraints are not established, subsequent pages will still return to the "writing and spelling" state.
## Rollout

- In the first step, only submit RFC and basic token / feedback primitives, do not directly change all pages at the same time.- The second step gives priority to transforming high-frequency paths: Task List, Create Task, Task Detail, Settings.- The third step is to disassemble the homepage and unify docs.- Keep existing routes and functions compatible to avoid affecting APIs and task processes.
## Acceptance

This RFC can be considered completed when the following conditions are met:
- Landing, app, and docs use unified tokens and core visual language.- Home page responsibilities have been split, and logged in users no longer use the hybrid home page.- There is no longer a new `alert()` / `confirm()` front-end interaction.- The app sidebar has a dashboard-like structure and foldable interaction.- The sidebar folding experience remains clear and usable in the expanded/collapsed state.- `CreateTaskDialog` changed to a mutually exclusive selection method that conforms to the cognitive model.- `TaskList` supports two views, `list` / `grid`, and maintains core operation consistency.- The visual hierarchy and interactive feedback of Task List, Task Detail, and Settings are significantly better than the current version.- New pages and new components no longer introduce undefined semantic variables (drift naming such as `--card`, `--text`).
## Open Questions

- Should I use different display fonts for landing and app, but share the body text system?- After logging in to the home page, should I jump directly to `/app/tasks` or add `/app/dashboard`?- docs Does it need to be fully integrated into unified navigation in this round, or only the visual layer should be unified first?- Is it necessary to design a stronger task creation and task details layout solution for the mobile terminal?- Should the default view of `TaskList` be differentiated by device type, or should the user's last selection be remembered uniformly?
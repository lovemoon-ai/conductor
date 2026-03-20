# Issue: Frontend create task dialog - productized flow

## Problem / Context

Currently `CreateTaskDialog` is working, but there are still obvious shortcomings in productization:
-Task types use checkbox to express mutually exclusive relationships- The cost of understanding the relationship between daemon / backend / task type is relatively high- Error prompts are still biased towards engineering- The whole thing is more like a "pile of form fields" than a clear task creation process
This issue corresponds to the upgrade of the high-frequency task creation process in RFC.

## Goal

Upgrade the creation task pop-up window to a creation process that is more in line with the cognitive model and more suitable for high-frequency use.

## Acceptance Criteria

- [ ] task type uses a selection method consistent with mutually exclusive awareness (such as radio card)
- [ ] The difference between AI Task and PTY Task is clearer to users
- [ ] Clearly express the relationship between daemon's available status and backend selection
- [ ] Creation failure, package restrictions, daemon unavailability and other statuses are expressed through unified UI feedback
- [ ] The entire creation process is significantly better than the current version on a visual and informational level

## Scope

- In scope
- task type selector transformation
- daemon / backend selection area hierarchy reconstruction
- Optimization of form validation and error feedback
- Modal copy and structure optimization
- Out of scope
- Create task API protocol modification
- Daemon ability model changes
- task detail page

## Plan / Tasks

- [ ] Reorganize the order of information in creating task forms
- [ ] Replace task type checkbox with radio card or equivalent
- [ ] Enhance daemon / backend availability copy and status expression
- [ ] Replace the current native error pop-up window with a unified feedback solution
- [ ] Supplementary form interaction testing and key status verification

## Risks / Dependencies

- Depends on dialog / feedback primitives in foundation issue
- If the back-end error payload is unstable, the front-end status expression may need to be carefully designed.

## Links

- RFC: `claw/rfc/0015-frontend-design-refresh.md`
Related code:
- 
- `web/src/components/conductor/tasks/CreateTaskDialog.tsx`
  - `web/src/components/conductor/common/Dialog.tsx`

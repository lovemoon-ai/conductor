# Mobile Task Project Swipe Transition

## Symptom

On the mobile task list page, swiping the project title to switch projects updated
the title and task list with a hard visual replacement. The interaction worked,
but the page appeared to flicker during quick project switches.

## Root Cause

The swipe handler immediately changed the selected project and URL query params,
so the header title and task list recomputed in the same render path without any
direction-aware transition state. React rendered the new project content
correctly, but there was no visual continuity between adjacent project views.

## Fix

Track a short-lived project switch direction in the task page when a title swipe
succeeds. Pass that direction to the header title and apply the same direction to
the mobile task list container, using a subtle slide/fade animation. Respect
`prefers-reduced-motion` so users who disable motion do not receive the
transition.

## Prevention

Swipe navigation should carry explicit transition direction state whenever the
gesture changes routed content. For mobile route-filter switches, verify both the
state transition and the visual continuity path in focused component tests.

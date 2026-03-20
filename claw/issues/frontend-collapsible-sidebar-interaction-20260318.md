# Issue: Frontend app shell - collapsible sidebar interaction

## Problem / Context

RFC adds new sidebar folding interaction requirements. For target experience, please refer to chatgpt.com:
- Expanded state can display complete navigation and context
- Keep the icon in the folded state, the currently selected state and the necessary tooltip
- User's folding preferences should be remembered
Although this area relies on sidebar redesign, its interaction details, state persistence, animation and accessibility are all worthy of being separated separately, otherwise it will easily be replaced by "make a fold button first", and the final experience will be unstable.

## Goal

Implement a stable, accessible, and durable desktop collapsible sidebar interaction.

## Acceptance Criteria

- [ ] Desktop sidebar supports expand/collapse switching
- [ ] The folded state can be restored after refreshing
- [ ] The folded state can still clearly display the currently activated navigation items
- [ ] Collapsed navigation has tooltip or equivalent understandable feedback
- [ ] Switching animation is restrained, stable, and does not cause layout flickering.
- [ ] keyboard with aria semantics available

## Scope

- In scope
  - sidebar collapse state
- Local persistence
- collapse toggle button and interaction
- tooltip/icon-only status availability
- Transition animations and responsive behavior
- Out of scope
- Overall visual structure design of sidebar
- Reconstruction of bottom navigation on mobile terminal
- task list content view switching

## Plan / Tasks

- [ ] defines sidebar expanded/collapsed state model
- [ ] Design the fold button position and interactive copy/icon
- [ ] Implement local state persistence
- [ ] implement folded tooltip / aria-label
- [ ] Adjust the layout transition of the content area when the sidebar width changes
- [ ] Verify keyboard navigation, focus, tooltip accessibility

## Risks / Dependencies

- Rely on sidebar redesign issue to provide basic structure
- If state persistence is not handled properly, it may cause SSR / hydration experience jitter
- If the animation is too heavy, it will affect the professional feel of the dashboard

## Links

- RFC: `claw/rfc/frontend-design-refresh.md`
Related code:
- 
- `web/src/app/app/layout.tsx`
  - `web/src/components/conductor/layout/Sidebar.tsx`

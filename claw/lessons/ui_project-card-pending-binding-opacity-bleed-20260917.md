# Pending-binding project card shows swipe action buttons through the card

## Symptom
- On the Projects page, a project card waiting for daemon binding (pending binding) renders with `opacity-70` on the whole card panel.
- Because the panel background becomes translucent, the always-mounted swipe-action button layer (`absolute inset-y-0 right-0 z-0`, behind the card's `z-10` panel) shows through: Invite / Hide / Delete icons are faintly visible even when the card is closed.

## Root cause
- `opacity` on an element applies to its entire box, background included. The card panel sits on top of the swipe-action layer only by z-order, not by opacity — dimming the whole panel inevitably reveals whatever is painted behind it.

## Fix
- Move the `opacity-70` off the card panel and onto a content wrapper `div` inside it (`web/src/features/projects/components/ProjectItem.tsx`). The card background stays fully opaque and continues to hide the action layer; only the title/chips/icon content is dimmed to convey the pending state.

## How to avoid next time
- Never use `opacity-*` to dim a container that has a visible background and is used as an occluding layer (z-index overlay, swipe-underlay, modal scrim). Dim the content instead, or dim via background/text colors.
- When a UI has a hidden layer permanently mounted underneath (swipe actions), treat the top layer's background opacity as part of the layering contract.

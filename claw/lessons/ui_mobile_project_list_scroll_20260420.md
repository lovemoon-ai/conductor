# Symptom

- On mobile, the Projects page could not scroll vertically when the project list was taller than the viewport.

# Root Cause

- `ProjectItem` applied `touchAction: none` to the sortable wrapper for the whole card.
- That disabled native vertical pan handling for touches that started on project cards, so the scroll container never received normal mobile scrolling behavior.
- Project dragging had already been scoped to the folder icon handle, so blocking touch actions on the whole card was no longer necessary.

# Fix

- Removed `touchAction: none` from the sortable wrapper.
- Kept `touchAction: none` only on the folder drag handle.
- Preserved card body `pan-y` behavior from swipe actions so vertical list scrolling remains available.
- Added a component test that verifies only the drag handle disables touch actions.

# How To Avoid Next Time

- Scope drag-specific touch behavior to the exact drag activator, not the entire interactive card.
- When a mobile card supports scroll, swipe, tap, rename, and drag, test the touch-action ownership for each area.
- Prefer `pan-y` on swipeable list cards so vertical page/list scrolling remains native.

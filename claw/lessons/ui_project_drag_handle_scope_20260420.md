# Symptom

- Project card sorting was unclear after switching mobile drag to a long-press interaction.
- Long-pressing the card body did not reliably start sorting on touch devices, and it also conflicted with card selection, swipe actions, and title rename.

# Root Cause

- The drag activator was wired at the whole card level while the component also used the card for selection and swipe gestures.
- After splitting dnd-kit sensors into mouse and touch sensors, the sortable activator events needed to be explicitly forwarded to the intended drag start area.
- The UI did not communicate a precise drag handle, so users could not tell where to press.

# Fix

- Moved sortable drag activator events onto the folder icon only.
- Kept the card body for selection and swipe actions.
- Kept title long-press reserved for inline rename.
- Added tests to verify that the folder icon starts drag and that the card body/title do not.

# How To Avoid Next Time

- Use a dedicated drag handle when a card has multiple touch gestures.
- Keep drag, swipe, select, and rename event ownership separate in component tests.
- Test touch sensor activator forwarding whenever changing dnd-kit sensor types.

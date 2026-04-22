# Symptom

- In the mobile task list, long-pressing the task title to rename was easy to trigger by accident while users were trying to scroll or swipe the card.
- The first pass at moving rename to the task card changed desktop behavior too, even though the requirement was mobile-only.

# Root Cause

- The rename gesture was attached to the title element, which sits inside a swipeable, scrollable card and therefore competed with normal mobile card interactions.
- The initial card-level rename implementation did not explicitly separate mobile and desktop interaction rules, so desktop list-pane behavior changed along with mobile.

# Fix

- Moved rename on mobile task lists from title long-press to double-click on the task card.
- Kept desktop list-pane behavior unchanged: title long-press still renames, and desktop card double-click still opens the full task page.
- Added timer cancellation around delayed mobile route opening so switching cards or pressing nested controls does not open the wrong task mid-interaction.
- Added component tests for the mobile double-click rename path, delayed-open cancellation, and preserved desktop behavior.

# How To Avoid Next Time

- When a gesture change is intended for one surface only, encode that scope explicitly in the component instead of relying on incidental layout context.
- For cards that support scroll, swipe, tap, double-tap, and long-press, review gesture ownership before changing any single trigger.
- When delaying navigation to make room for a gesture, add tests for cancellation paths across sibling cards and nested interactive controls.

# Symptom

- Issue cards showed linked-task terminal state like `killed`, which made the issue surface read as two competing status systems.
- From the issue view, users expected `doing` to mean "the issue is in progress" and `done` to mean "the issue is finished".

# Root Cause

- The issue card leaked task lifecycle detail directly into a surface whose primary entity is the issue.
- Historical linked-task state was useful for navigation, but not for status presentation on the card itself.

# Fix

- Removed linked-task status badges from issue cards.
- Kept the issue status badge as the only status indicator on the card while preserving the task link action.
- Updated component tests so issue cards no longer expect task terminal labels like `killed`.

# How To Avoid Next Time

- Keep each surface aligned to its primary entity; issue cards should present issue state, not task lifecycle detail.
- Treat linked resources as navigation affordances first, and only expose their internal state when that state is central to the current screen.
- When a UI combines issue and task concepts, decide explicitly which one owns status semantics before adding badges or labels.

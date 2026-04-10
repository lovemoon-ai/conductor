# Symptom

- In the Projects page, tapping a project immediately navigated away instead of behaving like a selectable card.
- The selected-state visual treatment felt inverted because unselected project cards looked more emphasized than selected ones.
- The Tasks navigation entry opened the global task list instead of the currently selected project's tasks.
- Task cards showed daemon metadata even though the daemon is already represented at the project level.
- The task page title format was awkward for scoped project views.

# Root Cause

- Project selection state was not modeled separately from navigation intent, so a single click both selected and navigated.
- Sidebar and mobile navigation always linked to `/app/tasks` and did not consume any current project selection.
- Project cards and task cards used different visual state conventions, which made the project list feel reversed.
- Task cards still rendered daemon metadata after the product moved toward project-level daemon ownership.
- The task page title was still built from the old `Task N · Project` pattern instead of a project-first scoped title.

# Fix

- Added persistent `selectedProjectId` state to the projects store and reused it across project list and navigation.
- Changed project-card click behavior to select the project, while keeping double-click available to open that project's tasks directly.
- Updated project cards to display daemon metadata and use the same selected/unselected surface semantics as task list panes.
- Updated sidebar and mobile task navigation links to route to the selected project's task list when present.
- Removed daemon chips from task cards.
- Updated the scoped task page title to `Project Name (N task/tasks)`.

# How To Avoid Next Time

- Separate selection interactions from navigation interactions when introducing card-based list UIs.
- Centralize scope state (such as current project) in a shared store before wiring navigation.
- Reuse existing selected/unselected surface tokens across related list components instead of restyling each surface independently.
- When metadata ownership moves from child entities to parent entities, audit all render surfaces to remove duplicated fields.
- Add UI tests for both selection persistence and scope-aware navigation whenever a list page controls downstream routing.

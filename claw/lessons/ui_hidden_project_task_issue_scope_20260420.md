# Symptom

- Hiding a project removed its card from the Projects list, but the all-project Tasks and Issues views still showed that project's tasks and issues.
- A hidden project could also be reached by keeping or manually opening a URL with `projectId`.

# Root Cause

- Hidden project state was applied only inside the Project list component.
- Tasks and Issues pages still treated a missing `projectId` as "all projects" without excluding locally hidden project ids.
- Route validation checked whether a `projectId` existed, but not whether that project was hidden locally.

# Fix

- Filter all-project task and issue views against `hiddenProjectIds`.
- Treat hidden `projectId` URL params as invalid and remove them from the URL.
- Added tests for hidden task filtering, hidden issue filtering, and hidden project URL cleanup.

# How To Avoid Next Time

- Project visibility state should be applied consistently at every project-scoped list boundary, not only where project cards render.
- When introducing local visibility state, add route-level tests for direct URL access in addition to list rendering tests.

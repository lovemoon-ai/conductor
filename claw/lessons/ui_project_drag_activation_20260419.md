# Symptom

- Project cards could begin dragging too easily while users were trying to interact with the project title.
- A first pass at long-press drag activation also made desktop mouse dragging feel delayed.

# Root Cause

- The project list used one pointer sensor activation rule for all pointer types.
- The project title pointer handler did not stop propagation before starting the edit long-press behavior.

# Fix

- Stop pointer propagation from the project title before title long-press handling.
- Split project drag sensors so mouse uses distance activation and touch uses long-press activation.
- Added a project list test that verifies mouse and touch activation constraints.

# How To Avoid Next Time

- Use pointer-type-specific drag sensors when the product requirement is about mobile accidental gestures.
- Keep nested long-press interactions from bubbling into parent drag surfaces.

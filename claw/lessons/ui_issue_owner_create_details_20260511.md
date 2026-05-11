# UI Bug: Issue Owner Edited In The Wrong Surface

## Symptom

Shared-project issue creation exposed an owner selector even though new issues should default to the current user and their own daemon. This made the owner and target daemon concepts look duplicated.

## Root Cause

The create dialog reused collaboration member options and sent `ownerUserId` during creation. The card also doubled as a reassignment surface, while the details dialog did not expose owner reassignment.

## Fix

Issue creation now omits owner selection and lets the API default owner to the current user. Issue owner reassignment moved to Issue Details, and selecting another collaboration member carries that member's local project id so runtime targeting changes with ownership. Issue cards only display the owner badge, using the last two digits for phone labels.

## Prevention

Creation forms should only collect fields needed for the initial object. Cross-member reassignment controls should live in the edit/details surface so ownership and runtime targeting stay visually tied to one decision, backed by API tests for non-owner status changes and cross-project moves.

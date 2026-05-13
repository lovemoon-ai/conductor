# UI Issue Card Single Member Owner Badge

## Symptom

Issue cards displayed owner/user information even when the selected project had only one collaboration member. In that state the owner badge added noise because there was no alternate user to distinguish.

## Root Cause

`IssueCardBody` always rendered `IssueOwnerBadge` whenever an issue had owner data. Nearby issue flows already treated owner selection as meaningful only when `ownerOptions.length > 1`, but the card display did not share that condition.

## Fix

Render the issue owner badge only when the project owner options contain more than one member. Pass owner options through the drag overlay so multi-member projects keep the same attribution while dragging.

## Prevention

When adding collaboration-only UI hints, keep card, dialog, list, and drag-overlay rendering behind the same member-count predicate. Add regression tests for both single-member hidden states and multi-member visible states.

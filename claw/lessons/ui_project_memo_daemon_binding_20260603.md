# Project memo should not bind to daemon rows

## Symptom

In a merged project with more than one project daemon, opening the project
settings details panel could expose memo state as daemon-row data. The panel
also told users that memos were stored on a specific daemon project row.

## Root Cause

Project memos were implemented in `project.metadata.memos`, while merged
projects are represented as multiple `Project` rows, one per daemon. The
details dialog still treated memo mutations as a single-row update and surfaced
daemon-specific copy, which contradicted the product model that memo is
project-level information.

## Fix

The details dialog now treats merged project memos as one shared timeline:

- It does not concatenate every daemon member's memo list into the panel.
- It removes daemon-scoped helper copy.
- It mirrors memo additions and deletions across every member in the merged
  group so future reads are not tied to whichever daemon row happens to render
  first.

Regression tests cover secondary daemon memo leakage and merged-group memo
fan-out.

## Prevention

When adding fields to project details, explicitly decide whether the field is
project-level or daemon-binding-level. For merged projects, project-level fields
must not use daemon row identity as the UX boundary; if the database still stores
them on `Project`, the UI needs a group-aware read/write policy.

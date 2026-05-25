# Generated Version PR Changeset Gate

## Symptom

The automatically generated `version packages` branch correctly bumped npm
packages to `0.4.0`, but its PR failed the published-package changeset check.

## Root Cause

The gate required every PR that modifies a published package to add a
changeset. A Changesets version PR intentionally consumes and deletes those
source changesets while updating package versions and changelogs, so the rule
rejected the release artifact it was meant to protect.

## Fix

The PR check now recognizes `changeset-release/main` as a generated version PR
only when its diff deletes one or more existing changeset markdown files. That
path may update package versions without adding a new changeset; ordinary
package PRs still require newly added release notes.

## Prevention

Every enforcement rule for source changes must include a testable path for its
generated release output. Validate a freshly generated version PR before
relying on the gate for a production release.

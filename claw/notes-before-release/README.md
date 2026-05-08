# notes-before-release

Pre-release notes that **must** be reviewed before each production release.

## Convention

- One markdown file per topic, named `{topic}-{YYYYMMDD}.md`.
- Each file lists concrete things to verify or risks to mitigate **before**
  the change ships to production: data migration safety, mixed-version risk,
  privacy/permission boundaries, observability gaps, rollback story, etc.
- Add a file as soon as a risk is identified — typically when QA closes a
  round with `passed_with_known_issues` or when a developer / reviewer flags
  an item that should not be forgotten between merge and ship.

## Lifecycle

- Files in this directory are **active reminders** until the relevant change
  is shipped.
- After a release goes out, every file in this directory must be cleared per
  `claw/sop/06_release.md`. The expectation is that the items have been
  resolved, accepted, or moved to a longer-lived doc (PRD, ADR, lesson, or
  follow-up issue under `claw/issues/`).
- Empty directory is the steady state. A non-empty directory at deploy time
  is a hard gate.

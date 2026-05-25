# Killed State Schema Fallback Build Compatibility

## Symptom

The Web production build failed while type-checking the task restart route
after `killedReason` and `killedAt` were introduced on the `Task` model.

## Root Cause

The full Prisma query returned the new killed-state fields, but the legacy
task-schema fallback shape did not provide them. In addition, databases that
had not yet applied the killed-state migration were not classified for the
existing rolling-deployment fallback.

## Fix

- Include `killedReason` and `killedAt` in the issue-id-only task select.
- Backfill both fields as `null` in the legacy task shape.
- Treat missing killed-state columns as schema compatibility errors so an
  application rollout can read a pre-migration database safely.
- Add tests for both the returned shape and missing-column detection.

## Prevention

When adding nullable Prisma fields used by API responses, update every
compatibility select and fallback shape in the same change, then run a
production Web build in addition to route tests before release.

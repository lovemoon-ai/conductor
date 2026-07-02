# Daily Reports Schema Bootstrap And Realtime Sync

## Symptom

Opening Daily Reports in local testing showed:

`Daily reports are unavailable until the database schema is updated. Run 'pnpm -C web db:push'.`

After later review, existing enabled daily-report settings could also keep an old pre-20:00 `next_run_at`, and other open tabs would not immediately reflect Daily entry visibility changes or a newly generated report.

## Root Cause

The local SQLite database used by the running server did not always have the new `daily_report_settings` and `daily_report_runs` tables. The app handled missing tables by returning a schema-unavailable message, but startup did not repair the local schema before the daily-report dispatcher ran.

The fixed 20:00 schedule changed application logic, but old rows could still contain previously computed run times. Realtime events were broadcast for setting changes and generated reports, but the frontend only refreshed history for report-ready events and ignored setting-update events.

## Fix

- Add an idempotent SQLite-only daily-report schema bootstrap before starting the daily-report dispatcher.
- Add startup schedule reconciliation so enabled settings with old send-time state are normalized to the next local 20:00 run.
- Handle `daily_report_setting_update` on the frontend to update the Daily navigation entry across open tabs.
- Refresh history and the currently open report when `daily_report_ready` arrives for the selected report date.
- Add focused tests for schema bootstrap, schedule reconciliation, navigation visibility, and realtime update handling.

## Avoid Next Time

For new persisted product features, include a local `db push` fallback or startup compatibility path when the documented dev flow can skip migration files. When changing a persisted schedule default, reconcile old rows explicitly instead of relying only on future writes. For every new realtime event, add both the producer and consumer tests in the same change.

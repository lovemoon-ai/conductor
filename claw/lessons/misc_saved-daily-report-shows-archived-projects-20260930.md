# misc: saved daily reports still listed projects archived later (CLI) (2026-09-30)

## Symptom
- After a project is hidden (archived), the web daily report page drops it from saved reports. `conductor settings reports show/list` still showed it and counted it in the totals.

## Root cause
- The server leaves hidden projects out only when it generates a report. Hiding a project after the report was saved was handled only in the web page (`excludeArchivedReportProjects`).

## Fix
- The filter moved to `lib/daily-reports/visible-projects.ts`. `getDailyReport` (for saved rows) and `listDailyReportRuns` now apply it with the user's current hidden project IDs, so every client gets the same result. The web page still applies the filter too, so a project hidden while the page is open drops out immediately.
- When a project is dropped, `summaryMarkdown` (shown by the web and by the CLI without `--json`) is rendered again from the remaining projects. An AI summary cannot be trimmed reliably, so it is replaced by that rule summary (`summarizer.status: fallback`).

## How to avoid
- If the rule reads current state (hide state), apply it when the data is read, not only when it is written.

# AI bridge local path fallback bug

> **Historical / superseded (2026-04-22).** The `@love-moon/ai-bridge`
> integration described here was removed in commit `34ae838`. Cross-
> backend task restart no longer translates JSONL sessions; it now hands
> the successor backend a `/share/<token>/plain` URL to fetch. See
> `claw/rfc/0021-feature-task-restart.md` for the current design notes
> and the supersession banner. The lesson is preserved for context.

## Symptom
- The CLI daemon defaulted to a developer-local absolute ai-bridge path.
- Restart flows that relied on ai-bridge could fail outside the original developer machine unless `CONDUCTOR_AI_BRIDGE_API_PATH` was manually set.

## Root cause
- Early integration used a local absolute path for fast bring-up.
- That fallback was never replaced with a package dependency after ai-bridge was published.

## Fix
- Add `@love-moon/ai-bridge` as a CLI dependency.
- Change the daemon default bridge loader to import `@love-moon/ai-bridge/dist/api.js`.
- Keep `CONDUCTOR_AI_BRIDGE_API_PATH` as an override for debugging and temporary local testing.

## How to avoid next time
- Any temporary absolute-path integration added for local bring-up should be tracked with a follow-up before merge.
- For shared runtime dependencies, prefer package-specifier imports in production code and reserve filesystem overrides for explicit debug env vars only.

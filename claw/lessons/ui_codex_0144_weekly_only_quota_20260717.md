# Codex 0.144 weekly quota was displayed as a 5h limit

## Symptom

After upgrading to Codex CLI 0.144, the AI Manager showed the weekly usage in the `5h` bar and showed an empty or zero-valued `Weekly` bar.

## Root cause

The quota parser assumed that Codex rate-limit header positions had fixed meanings: `primary` was always 5h and `secondary` was always weekly. Codex 0.144 removed the 5h limit, moved the only 10080-minute weekly window into `primary`, and omitted `secondary`.

## Fix

- Classify Codex quota windows by `window-minutes` instead of assigning a duration from the `primary` or `secondary` position.
- Prefer the explicit 10080-minute window, while retaining `secondary` as a fallback for older responses.
- Stop returning the obsolete 5h window in fresh results and strip it from old cached snapshots.
- Remove the Codex `5h` bar from the web UI; Claude and Kimi 5h bars remain unchanged.

## Prevention

Treat provider rate-limit positions as transport details, not product semantics. Protocol tests should cover both the current weekly-only response and the previous two-window response, and UI tests should assert which provider-specific quota labels are visible.

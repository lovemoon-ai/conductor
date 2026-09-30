# misc: `conductor settings global-backends remove` was case-sensitive (2026-09-30)

## Symptom
- `conductor settings global-backends remove macmini Claude` failed with "is not a global AI backend" even though `macmini / claude` was saved. `add` with different casing or extra spaces created a duplicate that the server then dropped.

## Root cause
- The server stores entries with the host trimmed and the backend trimmed and lowercased (`user-preferences.ts`). The CLI compared its raw arguments against those stored entries.

## Fix
- `add` and `remove` now apply the server's normalization to their arguments before comparing.

## How to avoid
- When a client compares its input against stored data, it must apply the same normalization the server used to store it.

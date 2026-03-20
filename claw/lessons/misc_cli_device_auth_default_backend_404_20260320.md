# misc: cli device auth default backend mismatch returns 404 (2026-03-20)
## Problem performance
- When the user runs `node cli/bin/conductor-config.js` from the source checkout, the CLI may call `https://conductor-ai.top/api/auth/device/start` by default.
- If the current device-auth API is only available on the local dev server, the CLI returns `Failed to start device authorization (404)` and the browser authorization flow cannot start.

## Cause analysis
- `conductor-config` defaulted to the production backend when `CONDUCTOR_BACKEND_URL` / `BACKEND_URL` were not explicitly set.
- The source checkout already contains a local web app with the matching device-auth routes, but the CLI did not detect that it was running from the repo.
- As a result, local feature development and local end-to-end verification depended on a production deployment state that could lag behind the branch.

## Solution
- Update `conductor-config` to prefer the local dev backend when running from the source checkout, while still letting explicit env vars override the target backend.
- Keep the production backend as the fallback for packaged / non-repo execution.
- Add focused CLI tests to cover both explicit backend override and repo-local default backend selection.

## How to avoid it next time
- For flows that depend on newly added local APIs, do not hardcode production as the silent default in repo-run tools.
- When CLI behavior differs between packaged usage and source-checkout usage, encode that distinction explicitly and test both paths.
- Add one end-to-end smoke test for any new auth/bootstrap path so backend selection mistakes fail before users hit them manually.

# Symptom

Copilot session and resume could silently use `GITHUB_TOKEN`, `GH_TOKEN`, or `COPILOT_GITHUB_TOKEN` from the environment instead of the machine's logged-in GitHub account, causing the wrong identity and quota to be used.

# Root Cause

Quota lookup already stripped GitHub token env vars by default, but normal Copilot session creation and resume lookup still passed the ambient environment through to the SDK. Copilot CLI gives those env tokens precedence over stored login state.

# Fix

Strip the three GitHub token env vars by default in Copilot session and resume client options, and default `useLoggedInUser` to `true` unless an explicit `githubToken` is provided.

# Avoid Next Time

Any auth-selection rule implemented for one Copilot entrypoint must be shared across quota, session, and resume paths. Add tests for all supported auth env vars and for the explicit-token override path whenever this logic changes.

# misc: `conductor daemon quota` omitted external-provider quotas (2026-09-30)

## Symptom
- The web AI Manager page shows quota for non-built-in backends (for example `codex-sol`). `conductor daemon quota <host>` never showed them.

## Root cause
- The web page works out the `externalQuotaBackend` list from the daemon's `supportedBackends` (everything that is not built in) and puts it in the query. `/api/ai-manager/quota` only passed that list on, so clients that did not send it (the CLI) got no external quotas.

## Fix
- The helper moved to `lib/agents/external-quota-backends.ts`. When the request names no external backends, the route builds the list from the connected daemon's `supportedBackends`. The web page imports the same helper.

## How to avoid
- If the web builds request parameters from server-known state, the server should build them itself.

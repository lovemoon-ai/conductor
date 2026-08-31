# conductor-sdk posts agent events to `/agent/events`, server serves `/api/agent/events` — every event 404s

- Severity: P2 (minor) — silent telemetry loss, no user-visible breakage
- Layer: routing (SDK backend client ↔ web API)
- Online issue card: `86d71d41-b497-47a0-a29a-e580fd62c9a8` (conductor @ macmini, P2, todo)
- Found: QA round 2026-09-01 while scanning `server.log` for non-2xx responses
- Status: **pre-existing and out of scope for the 0.11.1 release** — identical at
  v0.11.0, and `modules/conductor-sdk` has no commit in `v0.11.0..HEAD`

## Symptom

The dev server logs a steady stream of

```
POST /agent/events 404 in 18ms
```

29 of them in a single ~40-minute QA session, spread evenly from the first
minute to the last, i.e. one per agent event rather than a startup burst.

## Root cause (from the observable surfaces)

- `modules/conductor-sdk/src/backend/client.ts:348` requests
  `POST '/agent/events'`.
- The web app serves the route at `web/src/app/api/agent/events` — i.e.
  `/api/agent/events`.

Every other call in the same client uses the `/api/...` prefix, so this looks
like one missing prefix rather than an intentional unprefixed endpoint.

## Impact

Whatever agent events feed (diagnostics, analytics, activity timeline) has been
receiving nothing from any daemon or Fire. Nothing in the product visibly
breaks, which is exactly why it has survived: a 404 on a fire-and-forget POST is
invisible unless someone reads the server log.

## Suggested verification when fixed

Send one agent event and assert a 2xx in the server log, and assert the row
actually lands wherever `/api/agent/events` persists it — a 200 on the corrected
path is not by itself proof the payload shape still matches after however long
the endpoint has been receiving nothing.

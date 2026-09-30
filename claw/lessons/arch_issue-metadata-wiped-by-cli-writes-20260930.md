# Issue: every CLI write wiped the issue's metadata

## Symptom
`conductor issue update --title`, `issue start` and `issue done` (without
`--evidence`) erased `metadata.backendType`, `daemonHost`, `qa.evidence` and
`clientRequestId`. A later `issue start` no longer reused the remembered
backend/daemon, and `issue create --client-request-id` could create duplicates.

## Root cause
The SDK always sends `metadata` (it carries the `audit` namespace), and the
PATCH route replaced the stored metadata wholesale with whatever it received.
The web never noticed: it sends metadata only from the start dialog, already
merged with `issue.metadata` on the client.

## Fix
`PATCH /api/issues/:id` shallow-merges a metadata object over the stored one
(`null` still clears). The web's start dialog sends the full merged object, so
its result is unchanged; the SDK's `done --evidence` round-trip still handles
the nested `qa.*` merge.

## How to avoid next time
A partial-update route must not let one client's convention ("I send the whole
object") define the semantics. Merge on the server; never rely on every caller
round-tripping state.

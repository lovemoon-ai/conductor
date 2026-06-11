# Attached PTY View Lost After AI Task Kill

## Symptom

When an AI task with an attached PTY view was changed from `running` toward
`killed`, the PTY view could disappear or become unavailable even though the
attached PTY task still existed and should remain usable.

## Root Cause

`GET /api/tasks/:taskId` enriched AI task responses with `attached_terminal`,
but `PATCH /api/tasks/:taskId` returned the updated task without that
enrichment. The frontend merged the PATCH response into the task store and
treated the missing attached-terminal summary as `null`, which broke the
detail pane's link to the live PTY task.

## Fix

`PATCH /api/tasks/:taskId` now reloads the attached-terminal summary for AI
tasks before serializing the response. Regression tests cover both the API
response and the detail pane behavior where a killed AI task keeps rendering a
still-running attached PTY.

## Prevention

Mutation responses must preserve denormalized relationship fields that the
client uses as view state anchors. When `GET` enriches a task response, matching
mutation endpoints should either reuse the same serializer inputs or have tests
that assert the enriched fields survive lifecycle transitions.

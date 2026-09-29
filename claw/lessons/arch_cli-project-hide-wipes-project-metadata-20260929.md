# CLI `project hide/unhide` wipes the project's metadata

## Symptom
After `conductor project hide <p>` or `conductor project unhide <p>`, the project lost its
settings: task labels (`metadata.taskLabels`), project memos, binding data and anything
else stored in `project.metadata`. Hiding or unhiding the same project in the web UI did
not do this.

## Root cause
- `PATCH /api/projects?projectId=` *replaces* `project.metadata` with whatever `metadata`
  object it receives (`readProjectMetadataInput` serializes the input and the handler
  writes it directly). It does not merge.
- The SDK's `ProjectsApi.setProjectHidden` always sent
  `{ hidden, metadata: buildAuditMetadata(...) }`, and the CLI's `handleSetHidden` passed
  its own audit metadata through. So every hide/unhide overwrote the whole metadata blob
  with `{ audit: {...} }`.
- A review (H2a) had "fixed" hide by making sure the audit metadata actually reached the
  server, without checking that this route treats `metadata` as a full replacement.

## Fix
- `setProjectHidden` in `modules/conductor-sdk/src/api/projects.ts` now sends
  `{ hidden }` only, like the web UI.
- `handleSetHidden` in `cli/bin/conductor-project.js` sends `{ hidden }` (live and in
  `--dry-run`).
- Tests on both sides now assert the PATCH body is exactly `{ hidden: true }`.

## How to avoid it next time
- Before adding "audit metadata" to a write, check whether the route merges or replaces
  `metadata`. The task PATCH route merges; the project PATCH route replaces.
- When the CLI/SDK calls a route the web UI also calls, send the same body the web UI
  sends. Any extra field needs a reason and a server-side check.
- New CLI commands that edit project metadata (`conductor project labels ...`) do a
  read-modify-write of the full blob for this reason.

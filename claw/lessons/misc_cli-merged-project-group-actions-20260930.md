# misc: CLI hide/unhide/delete/merge-opt-out acted on one daemon of a merged project (2026-09-30)

## Symptom
- On the web, hiding, restoring, deleting, splitting or merging a cross-daemon merged project affects every daemon in the group. The CLI changed only the one row it resolved.
  - `conductor project hide repo` left the other daemons' rows visible, so the card stayed.
  - `update --merge-opt-out true` split off only one member.
- `conductor project labels …` only looked at the target's direct peers. It missed members that join the web group through a different anchor.
- The SDK's `listProjects()` dropped `hidden`, `mergeOptOut` and `gitRemoteUrl`, because `ProjectSummary.asObject()` rebuilt the project from a fixed list of fields. As a result, the CLI could not see which projects were hidden.

## Root cause
- The group logic lives only in web client code (`ProjectItem.tsx` and `features/projects/store.ts`). The server's project PATCH/DELETE changes one row, so each client has to expand the group itself.

## Fix
- The CLI now copies the web's grouping logic: `computeProjectGroups` over visible projects (all projects when the target is hidden), plus `expandMergedProjectGroup` for labels.
  - hide/unhide/delete act on every group member. `hide/unhide --json` prints the target project plus `ids` of every member changed.
  - `delete --daemon-host <h>` deletes only that copy. A group delete has no rollback, so it stops at the first failure and reports the deleted and remaining ids.
  - `--merge-opt-out true` opts out every member; `false` clears the flag on every same-name project on another daemon. The output lists those peers.
  - The `delete` confirmation message now says that tasks filed under other projects are also deleted.
- `ProjectSummary` now keeps the server payload in a WeakMap, so `asObject()` keeps the REST-only fields.

## How to avoid
- If a web action loops over "group members", the CLI must do the same loop, or the rule must move to the server.
- An SDK summary type must not quietly drop server fields that callers need.

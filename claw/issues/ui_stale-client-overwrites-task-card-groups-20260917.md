# ui: a client with a stale cache overwrites the server's newer task card groups on page load

- Date: 2026-09-17 (found during the v0.13.0..278f970 release QA round)
- Severity: P2. It loses a UI arrangement only: merged task cards split apart again. Tasks, messages and agent-group membership (`conductor task group`) are not affected, and re-merging the cards works around it.
- Status: **pre-existing, not a regression of this delta.** Card-group sync shipped in `a07e953` / `7f58a7e` (July 2026), both already in v0.13.0.
- Layer: web UI state sync (`/api/user-preferences/task-card-groups`)

## Symptom
Task card groups are synced across devices. Merged cards include the worker + reviewer card that an agent group creates (RFC 0033). When a browser that last saw an older group snapshot opens the Tasks page, it immediately `PATCH`es its own cached groups back to the server. That replaces a newer server snapshot, and every other client receives the overwrite in real time.

During the round, the C10 agent-group card (`QA917-U2-agents`) split back into two cards while another QA browser profile was loading task pages. It was re-wiped within 7 s after being restored.

## Reproduction (lead, deterministic)
1. Seed a group on the server: `PATCH /api/user-preferences/task-card-groups {"scope":"projects:all","groups":[{"id":"tabcard-qa917-probe","taskIds":[t1,t2],"labels":{…}}]}`. The response is revision 638 containing `tabcard-qa917-probe`.
2. In another browser profile, signed in as the same user, whose local state last held an older group (`tabcard-branch-0a269e3f…`, for tasks already deleted), open `/app/tasks`.
3. Within ~1 s that client sends two `PATCH … {"scope":"projects:all","groups":[{"id":"tabcard-branch-0a269e3f…", …}]}`.
4. `GET` the preference: it is now revision 640 containing only the stale group. `tabcard-qa917-probe` is gone.

## Expected
On load, a client should adopt the server snapshot (newer revision) rather than write its cached copy. Writes should be conditional on the revision the client last saw.

## Evidence
`claw/issues/tmp_release-qa-20260917/tmp_evidence/`:
- `grp-wipe-client-cli-alltasks.png` (+ `.console.log` / `.network.log`)
- `grp-wipe-summary.txt`, `grp-wipe-server-after.json`
- `c10-card-group-ws-frames.log` (the live wipe seen by the C10 agent)

## Suspected component
Task card group store hydration / persistence in the web client (task list), plus the unconditional PATCH handler for `task-card-groups`.

## Note for the fixer
This is a user-visible product bug. Per `CLAUDE.md`, add a lesson under `claw/lessons/` with the fix.

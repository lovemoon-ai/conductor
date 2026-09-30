# arch: a borrowed daemon could be lent on to a third person (2026-09-30)

## Symptom
- The web hides "Share" for daemons that were lent to you. But `conductor daemon share create <guest-host>` created an invite for someone else's machine anyway.

## Root cause
- `POST /api/daemon-shares` checks that the caller owns the daemon with `realtimeHub.hasAgentHost(host, user.id)`. A guest daemon connects under the grantee's user id, so this check passes for a machine the caller does not own. Only the web UI enforced the rule.

## Fix
- The route now also calls `findSharedGuestHosts`. If the host is an active share lent to the caller, it returns 400 "You cannot lend on a daemon lent to you".

## How to avoid
- "Online for this user" does not prove the user owns the machine once shares exist. Any owner-only daemon action must also exclude the caller's shared guest hosts on the server.

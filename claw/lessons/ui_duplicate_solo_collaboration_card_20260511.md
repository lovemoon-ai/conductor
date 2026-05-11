# UI Bug: Stale Solo Collaboration Card Hid The Real Shared Board

## Symptom

After invitation retries, one user could have two same-name project cards for the same workspace: an old `1/5 members` solo collaboration and the actual shared `2/5 members` collaboration. Creating issues from the solo card made collaborators think the issue board was one-way.

## Root Cause

The project list displayed every collaboration project independently, even when a stale one-member collaboration duplicated a workspace that was already part of a real multi-member collaboration.

## Fix

ProjectList now suppresses stale solo collaboration duplicates when the same project name and workspace path also have a multi-member shared collaboration. The real shared card remains visible even if its daemon is offline.

## Prevention

Collaboration UI should avoid showing multiple cards that represent the same local workspace unless they are intentionally distinct. Member count is part of the identity signal for shared project cards.

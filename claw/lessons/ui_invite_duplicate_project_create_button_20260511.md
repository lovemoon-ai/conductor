# Invite Card Duplicate Project Creation

## Symptom

When accepting a collaboration invite, the card could show `Create "<project>" & join` even though the user already had a project with that suggested name. Clicking it failed with `Project name already exists`.

## Root Cause

The invitation response only listed join candidates and did not tell the page whether the suggested auto-create name was already used by any of the user's projects, including the default scratch project that is filtered out of join candidates. The page therefore treated "no joinable project" as "safe to create".

## Fix

The invitation API now returns the suggested project name and whether it already exists. The invite page uses that signal to hide duplicate creation, select a same-name joinable project first, and only show create-and-join when the suggested name is available.

## Prevention

Invite acceptance UI should not infer creation availability from the candidate list alone. Candidate filtering and name availability are different server-side facts and both need explicit API fields plus component tests.

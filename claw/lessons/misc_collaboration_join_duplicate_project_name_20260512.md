# Collaboration Join Duplicate Project Name

## Symptom

Accepting a project collaboration invite could still create a second local project with the suggested name even though the invitation payload said that name was unavailable.

## Root Cause

The invite page used the correct name-availability signal, but the join API only checked for same-name projects where `daemonHost` was null before honoring `createProjectName`. A user who already had a daemon-bound project named `conductor` could bypass the UI intent by sending `createProjectName: "conductor"` directly, creating duplicate local project cards.

## Fix

The join API now treats any same-name project owned by the joining user as a conflict before creating an invite-paired project. The route test covers a daemon-bound same-name project and expects `409 Project name already exists`.

## Prevention

Whenever a UI exposes a server-provided availability flag, keep the same invariant enforced by the mutating API. UI suppression is only a hint; creation endpoints need their own complete conflict checks.

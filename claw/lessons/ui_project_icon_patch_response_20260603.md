# Project icons must survive partial project mutations

## Symptom

In local development, a project icon configured in `.conductor/settings.yaml`
rendered correctly after the project list was fetched. After changing project
state with hide/show or merge/split, the project card fell back to the default
folder icon until the user manually refreshed the list.

Production also did not show the Conductor project's configured icon.

## Root Cause

The project list `GET /api/projects` response enriched each serialized project
with `icon`, which is derived by reading `.conductor/settings.yaml` from the
project workspace. The `PATCH /api/projects` response returned only
`serializeProject(...)` without this derived field. The project store replaces
the row with the PATCH response after hide/show and merge/split updates, so the
client lost `icon` and fell back to the default folder icon.

The production missing-icon case had a deployment boundary: the web server read
`workspacePath/.conductor/settings.yaml` from its own filesystem. In
cloud/remote-daemon environments, the web server usually cannot read a user's
local workspace path, so settings-derived icons fall back to null.

The top-bar project refresh button only re-fetched the project list. It did not
call the existing `refreshProject` path, so it could not ask daemons to re-read
local settings and update cached icon snapshots.

## Fix

The projects API now serializes project responses through a shared helper that
adds `icon`. It prefers a daemon-reported icon cached in project metadata and
falls back to reading local `.conductor/settings.yaml` when the web server can
access the workspace path. `GET`, `POST`, and `PATCH` all return the same
icon-enriched project shape, so local state changes no longer require a manual
refresh to restore the icon.

The daemon now includes the resolved project icon in `validate_project_path`
results. When the API creates a bound project or refreshes a project, it caches
that icon snapshot in project metadata. Local file icons are inlined as data
URIs so the web server does not need access to daemon-local files. Local image
icons are capped before inlining, and oversized icon snapshots are not cached in
project metadata.

The existing top-bar refresh button now re-fetches the list, refreshes every
daemon-bound project currently in the list, and re-fetches once more so the UI
shows the latest daemon-cached icon snapshots.

Regression tests cover icons in project creation, hidden-state PATCH responses,
merge/split PATCH responses, daemon icon validation, and the top-bar refresh
button's daemon refresh path.

## Prevention

Any field computed outside the database row must be added consistently to every
API response that the frontend may use to replace store state. For cloud support,
do not rely on the web server reading daemon-local workspace files; have the
daemon report the icon and persist a resolved icon snapshot on the project row
or in metadata.

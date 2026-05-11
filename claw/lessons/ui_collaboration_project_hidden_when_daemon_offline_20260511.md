# Collaboration Project Hidden When Daemon Offline

## Symptom

Two users were joined to the same collaboration, but one user could not see the other member's issues and the project card did not show member information.

## Root Cause

The project list hid every project bound to an offline daemon. Shared issue boards do not require the daemon to be online, so this filtered out the actual collaboration project. With duplicate local project names, the user could then create issues in an older non-collaboration project with the same name.

## Fix

Project list filtering now keeps collaboration projects visible even when their daemon is offline. The card still shows the offline daemon state, and it also keeps the collaboration member count visible.

## Prevention

Availability filtering must be scoped to the workflow it protects. Daemon online status can gate task execution, but it should not hide collaboration metadata or issue-board navigation.

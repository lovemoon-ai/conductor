# Project reorder cross-device sync

## Symptom

Dragging projects in the project list changed the order in the current browser, but other devices or browser sessions did not update to the new order.

## Root Cause

The reorder API persisted `sortOrder`, but it did not notify app WebSocket clients after a successful reorder. Clients that missed the local optimistic update had no realtime signal to refresh their project list. The project fetch path also allowed older `/projects` responses to overwrite newer ordering state.

## Fix

Broadcast a `projects_reordered` app WebSocket event after `/api/projects/reorder` commits successfully. Clients refresh projects on that event and whenever the app WebSocket reaches `connected`, so missed broadcasts during disconnects are recovered. `fetchProjects` now ignores stale responses and responses from a previous JWT session, and logout resets project state.

## Prevention

Realtime mutations that affect cross-device UI state should either include enough payload to update all clients directly or emit an invalidation event that triggers a guarded refetch. Tests should cover the API broadcast, client event handling, reconnect recovery, stale request ordering, and session-token changes.

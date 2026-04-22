# UI Task Title Hide Persistence

## Symptom
Double-clicking the Tasks page title toggled the running-only task view only in local React state. Leaving the page or opening the app on another device reset the view to showing all tasks.

## Root Cause
The title double-click state lived in `TasksPage` and was never persisted to user-scoped storage. The real-time client also had no user preference event path, so other app sessions could not receive preference updates.

## Fix
Added a user preference table and `/api/user-preferences/task-list` route for authenticated reads and writes. The Tasks page now hydrates and updates this server-backed preference through a user preference store, and preference writes broadcast a `user_preference_update` WebSocket event to other app connections for the same user.

## Prevention
UI state that users expect to survive navigation or device changes should be modeled as a user preference with a server API and synchronization path, not as component-local state.

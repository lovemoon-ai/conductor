# ui: zombie daemon remains visible after frontend agent list goes stale (2026-03-23)

## Symptom

- A daemon such as `mlx` had already dropped offline on the backend side.
- The frontend still showed it in the daemon list / daemon selector.
- Users could see a "connected" daemon entry that no longer existed in `/api/agents`.

## Root cause

- The frontend agent store only fetched `/api/agents` on initial page load and on the settings page mount.
- After that first fetch, the in-memory list stayed unchanged unless the user manually reloaded a page that happened to refetch.
- So when a daemon disconnected later, the backend presence state was updated correctly, but the frontend kept rendering stale cached agent data.

## Fix

- Added background polling to `useAgentsStore`.
- Started polling from the authenticated app layout so the daemon list keeps refreshing during normal use.
- Used silent refresh for polling so the UI does not flicker or re-enter loading state every cycle.
- Prevented duplicate polling timers and made polling stop when the session is unavailable.

## How to avoid next time

- Any UI that renders realtime-ish presence data must define an explicit refresh strategy: push, polling, or TTL invalidation.
- Do not treat one-time bootstrap fetches as durable truth for connection state.
- Add regression tests around stale presence caches, especially for daemon / fire / agent online state surfaces.

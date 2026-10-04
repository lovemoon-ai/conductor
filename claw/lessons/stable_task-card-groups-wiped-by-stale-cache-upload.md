# Task card groups not persisted / not synced across devices

## Symptom
Tab cards (tasks merged by dragging one card onto another) did not stick: a
group made on one device was missing on another, and sometimes vanished on the
device that made it after a reload. The server row for the groups preference
showed a very high revision count (1000+ writes for one user), mostly no-op or
empty writes.

## Root cause
`TaskList` loads this browser's cached groups on mount and calls
`setGroups(loaded)`. A `skipGroupSaveRef` flag was meant to stop that load from
being saved, but the save effect consumed the flag on the *first* commit
(before `loaded` was even rendered). The re-render caused by `setGroups(loaded)`
then ran the save effect again with the flag cleared, and it **PATCHed the local
cache to the server before the server snapshot had been fetched**.

On a second device the cache is stale or empty, so the upload replaced the
global scope (`projects:all`) with `[]` or stale groups and broadcast that
to every other device. Because the PATCH bumped `mutationSequence`, the sync
store also ignored the in-flight hydration GET, so the bad snapshot stuck.

## Fix
- `TaskList` tracks `serverGroupsAppliedRef`: it is reset when the user or scope
  changes and set once the hydrated server snapshot has been folded into
  `groups`. The save effect still writes localStorage, but it only uploads after
  that.
- A *failed* load is not a server read. The sync store's `hydrated` turns true
  after a failed GET too, with an empty snapshot that looks like "the server has
  no groups". That would have sent us down the legacy-migration path and
  uploaded the local cache anyway. The store now has `serverLoaded`, set only
  after a successful GET/PATCH or a realtime snapshot. `TaskList` waits on it,
  stays local-only meanwhile, and retries the load every 15 s.
- When the server has no global scope yet (legacy per-project scopes only), the
  sync effect now uploads the consolidated union itself. Before, it relied on the
  save effect, which never fires if the local groups already equal the union.
- Regression tests: "does not upload the local cache before the server snapshot
  is hydrated" and "does not overwrite server groups with an empty local cache
  on load" in `TaskList.test.tsx`.

## How to avoid next time
- Never push local state to a server-authoritative store until the server
  state has been read successfully at least once. "Load finished" and "load
  succeeded" are different states; an error path must not unlock writes. Gate on an explicit "server applied" signal,
  not a one-shot skip flag.
- One-shot `skipXRef` flags around `useEffect` are fragile: the flag and the
  render it was meant to skip are often in different commits. Prefer an explicit
  readiness or "dirty because the user acted" signal.
- A preference row whose revision climbs much faster than user actions is a
  sign of echo or clobber writes. Check it when debugging sync.

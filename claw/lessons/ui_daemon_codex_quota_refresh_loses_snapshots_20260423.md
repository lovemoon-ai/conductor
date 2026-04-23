# Symptom

- On the daemon settings page, inactive Codex accounts displayed their
  last-known quota bars while the page was open — matching the spec:
  *"当切换其他账号，没激活的quota保留显示最近一次刷新的quota信息"*.
- After a **full page refresh**, the same inactive accounts showed empty
  bars and the "no quota snapshot yet" placeholder. Only the currently
  active account re-populated (via the live `fetchQuota` poll).
- Users perceived this as data loss on refresh.

# Root Cause

- `codexQuotaByAccount` lived only in the Zustand store, which is
  in-memory per tab. A hard refresh reinitialized it to `{}`.
- The store was populated exclusively by live `fetchQuota` calls — which
  only ever fetch for the **currently active** account — so inactive
  accounts never got a chance to refill without a switch-and-switch-back
  dance.
- Meanwhile the daemon already had what we needed: a per-account quota
  cache on disk at `${DEFAULT_QUOTA_CACHE_DIR}/quota-codex-<fingerprint>.json`
  (`modules/ai-manager/src/quota/cache.ts`), keyed by `identityFingerprint`
  derived from each auth.json. The data was authoritative and durable
  across page refreshes — it simply wasn't exposed to the web client.

# Fix

- Added `readCachedCodexQuota(authPath)` in
  `modules/ai-manager/src/quota/codex.ts`: parses an auth.json, computes
  its identity fingerprint, reads the on-disk cache entry, and returns
  the snapshot with `source: 'cached'`. Swallows every error (missing
  auth, malformed JSON, missing cache) and resolves to `null`, so one
  broken account never breaks the list.
- Exposed it through `AiManager.readCachedCodexQuota(authPath)` and the
  package's top-level exports.
- Extended the daemon's `list_accounts` handler
  (`cli/src/ai-manager-handlers.js`) to enrich every returned
  `CodexAccount` with its `cachedQuota`, resolved in parallel.
- Mirrored the optional `cachedQuota?: CodexQuota` field on the
  frontend's `CodexAccount` type.
- Taught the frontend `fetchAccounts` action to seed
  `codexQuotaByAccount` from each account's `cachedQuota`, but **only
  for keys that aren't already present in memory** — the live poll's
  fresh data always wins over the disk snapshot.

# How To Avoid Next Time

- When the daemon already caches something on disk, prefer surfacing
  that cache to the web client over adding client-side persistence
  (localStorage / zustand `persist` middleware). The daemon's copy is
  authoritative, works across browsers, and doesn't require a schema
  migration when the shape changes.
- UI state that's meant to "persist" (e.g. "keep showing last known")
  must identify a source of truth that outlives the browser tab —
  otherwise the feature silently breaks on refresh. Add a quick
  mental checklist when adding per-item snapshots: *Where does this
  live when the tab dies? Is that explicit in the design?*
- Seed-but-don't-overwrite is the right merge rule when combining a
  durable daemon snapshot with live poll data: the in-memory entry is
  always at least as fresh, and cache is only ever a fallback for
  missing keys. Tests should lock this invariant in so a well-meaning
  refactor can't swap the merge order.

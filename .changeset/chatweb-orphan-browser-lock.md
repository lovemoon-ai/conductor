---
"@love-moon/conductor-cli": patch
"@love-moon/ai-sdk": patch
"@love-moon/chat-web": patch
---

fix: reclaim orphaned chat-web browser and cap chat-web task lifetime

chat-web persists one Chromium profile per provider, guarded by a per-profile
SingletonLock. A task whose browser was not cleaned up (e.g. the ai-sdk worker
was SIGKILLed) left an orphaned Chromium holding that lock, so the next task for
the same provider failed to launch with `Opening in existing browser session`.

- chat-web now reclaims stale/orphaned profile locks before launching (kills an
  orphan whose owner process is gone, clears dead locks) and refuses with a
  clear `ProfileLockedError` when a genuine live chat still holds the profile.
- The ai-sdk worker now closes its session (and browser) on SIGTERM/SIGINT and
  bounds the close so it can't hang, preventing browser leaks on shutdown.
- conductor fire caps a chat-web task's active lifetime (default 24h,
  `CONDUCTOR_CHATWEB_MAX_ACTIVE_MS`) and auto-stops it as
  `KILLED / max_active_duration`; chat history is preserved.

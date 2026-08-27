# @love-moon/chat-web

## 0.10.0

## 0.9.0

## 0.8.0

## 0.7.7

## 0.7.6

## 0.7.5

### Patch Changes

- f91a5df: Read Codex weekly quota from the official app-server account rate-limit RPC, ignore model-specific buckets, and invalidate legacy response-header caches.

## 0.7.4

## 0.7.3

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.1

## 0.6.0

## 0.5.1

### Patch Changes

- 39a49fc: fix: reclaim orphaned chat-web browser and cap chat-web task lifetime

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

## 0.5.0

## 0.4.2

## 0.4.1

### Patch Changes

- aada753: Add explicit ChatGPT and Gemini web backend aliases, expose project icon
  configuration in generated CLI settings, and default browser-backed session
  checks to headed mode for reliable authenticated detection.

## 0.4.0

### Minor Changes

- 4ecc359: Publish the chat-web browser runtime and wire it into the CLI and AI SDK for
  ChatGPT and Gemini web sessions, including provider error handling and local
  development installation support.

  Ship app SDK realtime history catch-up and the CLI/AI SDK goal-mode and custom
  command runtime updates included in this release.

## 0.3.2

### Minor Changes

- Introduce the browser-backed chat runtime for ChatGPT, DeepSeek, and Gemini
  providers, packaged for integration with `@love-moon/ai-sdk`.

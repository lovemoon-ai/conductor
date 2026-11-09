# @love-moon/chat-web

## 0.18.1

## 0.18.0

### Minor Changes

- 72324fd: Add a local multi-chat runtime with isolated Chromium workers, persistent profiles,
  per-account concurrency, resumable events, request deduplication, and SDK/CLI access.
  Add experimental Kimi and Claude webpage adapters and optional AI SDK socket transport.

  Support Kimi Connect JSON envelopes and DeepSeek XHR SSE patches, with verified
  parallel real-account text chats, independent cancellation, and restart recovery.

  Add DeepSeek --deepthink / --no-deepthink controls and SDK options with persisted
  chat defaults, per-turn overrides, verified UI state, and runtime capability checks.

  Connect Conductor web-kimi and web-deepseek to managed isolated Chromium workers
  by default. Add conductor chat-web login, account credential bootstrap, automatic
  daemon startup and idle shutdown, stable cross-process resume IDs, and browser
  release when tasks close. Preserve the shared-profile queue for other providers.
  Retain cancelled conversation URLs and report confirmed stops as interruptions.

### Patch Changes

- bdbda18: Preserve lightweight conversation identity archives across profile/history GC so
  Conductor can resume the same provider conversation using its existing local ID.
  Archive idle, workerless open chats; persist the completed-turn resume guard; and
  distinguish slow page loading from confirmed authentication failures.

  Upgrading a CLI while an older managed runtime is running can report
  RUNTIME_UPGRADE_REQUIRED when queuedStartup or durableResume support is missing.
  After active chats finish, run `conductor chat-web runtime stop` and retry;
  the next managed session starts the updated runtime. Alternatively, a runtime
  with no active turns or pinned login windows exits after ten minutes without
  requests. The CLI never terminates running chats automatically.

  Profile deletion now starts only after the retention checkpoint commits, and
  closed chats awaiting uncertainty review retain their profiles and turn history.
  Accepted prompts refresh idle activity before collection, keeping their parent
  conversation resident even when a client submits directly after a long idle.

- d31f07b: Show actionable Kimi and DeepSeek account concurrency errors in Conductor chat.
  Preserve bounded provider messages and typed errors through the existing runtime,
  AI SDK and chat error channel without automatically retrying submitted turns.
- 063b97c: Show daemon-host inspection and acknowledgement commands on uncertain chat-web
  errors and REVIEW_REQUIRED, including interrupted sends and timeouts. Keep
  acknowledgement explicit: it does not replay a request, and the user sends the
  next message after checking the provider conversation. The web error message
  contains the commands; acknowledgement currently runs through the host CLI.

  Compact streamed event history into full text snapshots instead of failing
  after 2000 events. Sequence numbers remain monotonic across compaction and
  restart; replay cursors may cross gaps and recover through a message_snapshot.
  The one-million-character text limit remains enforced.

  Return CHAT*CLOSED when closing a chat races a headed resume. Strip CONDUCTOR*\*
  identity variables from detached runtime and browser-worker environments while
  preserving browser and proxy configuration.

  Upgrade note: an already-running shared runtime continues executing its old
  code. After active chats finish, run `conductor chat-web runtime stop` and retry
  to launch the updated runtime. Older runtimes lacking required capabilities
  report RUNTIME_UPGRADE_REQUIRED; unused managed runtimes exit after ten minutes
  without requests or pinned login windows. No running chat is stopped
  automatically during upgrade.

- 31b61ea: Bound closed-chat and terminal-turn retention, reclaim browser profiles and orphan
  directories, and keep streaming deltas in memory between durable checkpoints.
  Defer saturated or busy chat startup to the turn queue, validate authentication at
  allocation, and expire queued prompts before crash recovery or delayed submission.
  Keep Gemini on its legacy transport with global runtime sockets and consume the
  Conductor wrapper separator before forwarding a packaged CLI command.

## 0.17.2

### Patch Changes

- b124565: Add QueuedChatSession with a shared local browser broker and a FIFO turn queue
  across processes. Each task retains its own conversation tab; idle tasks no
  longer hold exclusive access to the provider profile. The AI SDK uses queued
  sessions when available and reports waiting positions through working status.

  Cancel pending turns on disconnect, stop/close failed conversation tabs before
  advancing the queue, and release the browser after its last client exits.
  Keep the exclusive ChatSession API available for direct Playwright access.

  Keep logical sessions usable after an active stop, timeout, or provider failure.
  Restore the original provider conversation for the next explicit user operation;
  require explicit clear when safe restoration is unavailable, and never replay a
  failed prompt. Allow clear after a failed first submission. Correct the Windows
  named-pipe address escaping.

- 0a9488e: Add Kimi website text conversations with persistent login, multi-turn context,
  reply progress, new chats and browser diagnostics. Expose the provider through
  ai-sdk's chat-web backend and the web-kimi Conductor configuration alias.

  Explicit unknown chat-web providers now fail with a clear error instead of
  silently opening ChatGPT. The existing kimi CLI backend is unchanged.

## 0.17.1

## 0.17.0

## 0.16.0

## 0.15.2

## 0.15.1

## 0.15.0

## 0.14.0

## 0.13.3

## 0.13.2

## 0.13.1

## 0.13.0

## 0.12.0

## 0.11.2

## 0.11.1

## 0.11.0

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

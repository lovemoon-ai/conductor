# @love-moon/app-sdk

## 0.5.0

### Minor Changes

- 5fd165b: Align the app SDK ChatView with the Conductor web chat experience: add
  dedicated MessageBubble and QuestionNav components, expand MessageList
  rendering, and reset chat store state on task switch (covering restart).
  Also ship the REST adapter task hooks and an app-sdk integration guide.

## 0.4.2

## 0.4.1

## 0.4.0

### Patch Changes

- 4ecc359: Publish the chat-web browser runtime and wire it into the CLI and AI SDK for
  ChatGPT and Gemini web sessions, including provider error handling and local
  development installation support.

  Ship app SDK realtime history catch-up and the CLI/AI SDK goal-mode and custom
  command runtime updates included in this release.

## 0.3.2

### Changed

- `ChatEvent.task_failed.error` and `StreamReplyDelta.error` now include
  optional `details?: unknown` and `cause?: unknown` fields. Additive,
  non-breaking — existing consumers ignore the new fields. The default WS
  → ChatEvent translation forwards both from `ConductorAppError`, so host
  UIs can surface server payloads / request IDs / underlying causes without
  depending on the SDK error class directly. The `<ChatView />` React store
  (`useChat().state.error`) also carries these through.
- `examples/02_bff` BFF now hardcodes `role: 'user'` and strips
  `metadata.audit` on `POST /messages`. **Integrators copying the example
  must follow this pattern.** Without it, a malicious browser could forge
  `role: 'system'|'assistant'` messages or stamp `audit.actor='app'` —
  bypassing `streamReply`'s SDK-echo filter and impersonating server-side
  app messages. The BFF is the only point in the pipeline that knows the
  browser is untrusted; do not push role/audit choices down to the SDK.
- `client.tasks.streamReply()` now applies a default **120s idle timeout**
  between consecutive `text` / status-transition deltas. If no progress is
  observed in that window the iterator yields a terminal
  `{ type: 'error', error: { code: 'stream_aborted', message: 'idle timeout' } }`
  and closes. Long-running backends (e.g. tools that may legitimately go
  silent for minutes) can opt out by passing `idleTimeoutMs: 0`:

  ```ts
  for await (const delta of client.tasks.streamReply(taskId, {
    idleTimeoutMs: 0,
  })) {
    // never time out — caller is responsible for cancelling via signal
  }
  ```

- **Locked down the public `.d.ts` surface.** Internal transport types —
  `Fetcher`, `FetcherOptions`, `RequestOptions`, `AppWebSocket`,
  `AppWebSocketOptions`, `TasksRestApi` — are now tagged
  `/** @internal */` and stripped from generated d.ts via tsup's
  `dts.compilerOptions.stripInternal`. Previously these appeared as
  `declare class …` in `dist/server/index.d.ts` (even though not
  re-exported) and TypeScript surfaced them on hover / structural
  reference. The `AppClient._internals` test-seam getter has been removed
  (it was unused). The CI `bundle-smoke` script now also asserts none of
  these symbols leak into any d.ts as a regression net.
- **`AppClient.close()` now safely terminates in-flight subscribe
  iterators.** When a `for await` loop on `tasks.subscribe(taskId)` is
  mid-stream and the caller invokes `client.close()`, the iterator now
  yields a synthetic
  `{ type: 'task_failed', taskId, error: { code: 'subscribe_failed', message: 'client closed' } }`
  and returns instead of hanging silently. Same for `tasks.streamReply()`
  — it surfaces an `{ type: 'error', error: { code: 'subscribe_failed' } }`
  delta. `close()` is also idempotent (a second call is a no-op). After
  close, calls to `tasks.subscribe()` / `tasks.streamReply()` / any
  `tasks.*` REST method throw a synchronous
  `ConductorAppError({ code: 'subscribe_failed', message: 'client is closed' })`
  rather than returning a hanging iterator. Implemented internally by a
  new `AppWebSocket.onClose(listener)` channel; the public API surface
  is unchanged.

## 0.1.0

Initial implementation, RFC 0027 milestones M0–M3.

### Added — package layout (M0)

- Single npm package with three subpath entries:
  - `@love-moon/app-sdk` (root, types-only + `SDK_VERSION`)
  - `@love-moon/app-sdk/server` (Node)
  - `@love-moon/app-sdk/react` (browser / React)
  - `@love-moon/app-sdk/react/styles.css`
- tsup multi-entry build; per-entry tsconfig conditions.
- `react` + `react-dom` as optional peer dependencies — server-only consumers
  don't get warnings.
- CI bundle smoke test (`npm run test:bundle`) statically asserts no Node
  symbols leak into `/react` and no DOM symbols leak into `/server`.
- vitest with per-file `@vitest-environment` directives (node + jsdom).

### Added — `/server` (M1)

- `connect()` + `AppClient` with `projects` and `tasks` sub-APIs.
- `projects.bind()` — idempotent find-or-create on (daemonHost, workspacePath);
  stamps `metadata.audit.createdByApp` on creation (zero schema change).
- `projects.list()` / `projects.get()`.
- `tasks.create()` / `tasks.get()` / `tasks.list()`.
- `tasks.sendMessage()` with auto-generated `clientRequestId` (idempotent).
- `tasks.history()` with cursor-based pagination.
- `tasks.interrupt()` with `targetReplyTo`.
- `tasks.subscribe(taskId)` — `AsyncIterable<ChatEvent>` over `/ws/app` with
  taskId-side filtering, capped backoff reconnect, and a per-iterator abort.
- `tasks.streamReply(taskId)` — `AsyncIterable<StreamReplyDelta>` built on
  subscribe; yields `text` deltas from `reply_preview` plus a terminal `done`
  on the assistant message (or `error` on `task_status_update=failed`).
- Unified `ConductorAppError` with named error codes mapped from HTTP status
  - backend error strings.
- Custom fetch / WebSocket / bearerToken providers for SSR + test injection.

### Added — `/react` (M2)

- `<ChatView />` — composed widget: runtime status bar + message list + input.
- `<MessageList />`, `<MessageInput />`, `<RuntimeStatusBar />` —
  building-block components for compose-your-own layouts.
- `<ChatProvider />` + `useChat()` — React Context + useReducer chat state
  (no zustand dep; per-instance store so multiple widgets on the same page
  don't collide).
- `createRestAdapter()` — default `ChatAdapter` implementation that talks to
  a host BFF exposing 4 routes (`messages` GET/POST, `interrupt`, `events`
  SSE).
- Optimistic send → server confirm flow with pending-message replacement.
- Pre-compiled CSS at `@love-moon/app-sdk/react/styles.css`; CSS-variable
  theming via the `theme` prop; mobile/desktop layout via responsive CSS
  - an explicit `layout` prop override.
- jsdom integration tests covering hydration, live events, runtime status,
  interrupt button visibility, and optimistic send.

### Added — examples + docs (M3)

- `examples/01_example/` — minimal Node CLI demo: bind project → create task
  → stream AI reply to stdout. ~35 lines of business code, no UI / BFF.
- `examples/02_bff/` — runnable Next.js demo: BFF wraps `/server`,
  page mounts `<ChatView />`, ~120 lines of business code total.
  - `lib/conductor.ts` — singleton AppClient.
  - `app/api/conductor/bind/route.ts` — `projects.bind()` + `tasks.create()`.
  - `app/api/conductor/[...path]/route.ts` — catch-all BFF translating to
    the 4 widget-expected routes, including a 30-line SSE bridge over
    `tasks.subscribe()`.
- README with quickstart, full integration recipe, and security model.

### Known gaps

- v0.1 chat UI is functional but visually minimal. RFC §4 phase B (physical
  extraction of `web/src/features/chat` polished components, including
  Markdown / attachments / 1423-line regression test) is a follow-up PR.
- Streaming surface yields `text` cumulative previews, not token-level
  deltas. Real token streaming requires a backend envelope addition; the
  `StreamReplyDelta` shape is forward-compatible.
- Attachments not implemented in the default REST adapter or `<ChatView>`;
  `Attachment` types are defined for forward compat.

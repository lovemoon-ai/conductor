# Integrate the Conductor App SDK

This document describes how a new third-party app embeds Conductor AI tools
using [`@love-moon/app-sdk`](../../modules/app-sdk): how to wire it up, which
components are available, how to use each, and the caveats that bite in
practice.

The package source lives in [`modules/app-sdk`](../../modules/app-sdk); two
runnable reference apps live in
[`modules/app-sdk/examples`](../../modules/app-sdk/examples). When in doubt,
the examples are the source of truth — this doc explains *why*, they show
*exactly how*.

---

## 1. What you get & the architecture

One npm package, three subpath entries:

| Import | Runs in | Use it for |
| --- | --- | --- |
| `@love-moon/app-sdk` | anywhere (Node / browser / edge / RSC) | Pure **types** + constants (`SDK_VERSION`, `ConductorAppError`). |
| `@love-moon/app-sdk/server` | Node 18+ | Your **backend** talking to Conductor REST + `/ws/app`. Holds the token. |
| `@love-moon/app-sdk/react` | browser / React 18+ | The **chat widget** (`<ChatView />`), wired by a `ChatAdapter`. |

The intended deployment has a hard trust boundary — **the Conductor token
never reaches the browser**:

```
[browser: <ChatView/>] ──HTTP──▶ [your BFF: holds token] ──REST + /ws/app──▶ [Conductor] ──▶ [daemon]
```

The widget talks **only to your backend-for-frontend (BFF)**. The BFF
authenticates your own user, then forwards to Conductor using the server-held
token.

> Why a single package with three entries: the widget and the BFF must agree
> on wire format and event shapes. Shipping them together with shared types
> makes that contract impossible to accidentally split. Subpath exports keep
> Node code out of browser bundles and React out of server-only consumers.

---

## 2. Pick your integration shape

| Shape | When | What you need |
| --- | --- | --- |
| **Backend-only** | Cron jobs, agents, CLIs, server workflows. No chat UI. | `@love-moon/app-sdk/server` only. See §4. Reference: [`examples/01_example`](../../modules/app-sdk/examples/01_example). |
| **Browser chat widget** | You want the `<ChatView />` chat UI in a web app. | `/server` (BFF) **and** `/react` (widget). See §4 + §5. Reference: [`examples/02_bff`](../../modules/app-sdk/examples/02_bff). |
| **Custom UI** | You want your own React UI, not `<ChatView/>`. | `/server` (BFF) + a custom `ChatAdapter` and/or `useChat()`/`ChatProvider`. See §6.6–§6.7. |

---

## 3. Prerequisites

You need, from the Conductor side:

1. **Base URL** — e.g. `https://conductor.example.com`.
2. **Bearer token** — minted in Conductor *Settings → API Tokens*. This token
   is equivalent to the user's account. Treat it like a password (see §7.1).
   If your app uses Conductor SSO, the exchanged `access_token` works here too
   (see [add-new-sso-client.md](./add-new-sso-client.md)).
3. **Daemon host** + **workspace path** — the binding identity of the project
   your tasks run in (the machine running `conductor daemon` and the absolute
   path it should operate in).

Install:

```bash
npm install @love-moon/app-sdk
# React peer deps only needed if you use /react:
npm install react react-dom
```

---

## 4. Backend integration (`/server`)

Everything here runs server-side and uses the token. The smallest possible
app — bind a project, create a task, stream the reply — is ~35 lines; see
[`examples/01_example/chat-cli.mjs`](../../modules/app-sdk/examples/01_example/chat-cli.mjs).

### 4.1 Connect

```ts
import { connect } from '@love-moon/app-sdk/server';

const client = await connect({
  baseUrl: process.env.CONDUCTOR_BASE_URL!,
  bearerToken: process.env.CONDUCTOR_TOKEN!,   // string OR () => Promise<string>
  // Optional:
  // timeoutMs: 30_000,            // per-request timeout (default 30s)
  // lazyWebSocket: true,          // open /ws/app only on first subscribe (default true)
  // onUnauthorized: () => {...},  // called once on any 401
  // fetch: customFetch,           // SSR / testing
});
```

`connect()` returns an `AppClient`. In a long-lived process keep **one
client** (it owns a single, lazily-opened `/ws/app` socket) and `await
client.close()` on shutdown. In a Next.js BFF, cache it as a module singleton —
see [`examples/02_bff/lib/conductor.ts`](../../modules/app-sdk/examples/02_bff/lib/conductor.ts).

### 4.2 Bind a project (idempotent)

```ts
const project = await client.projects.bind({
  name: 'Acme Dashboard',
  daemonHost: process.env.CONDUCTOR_DAEMON_HOST!,
  workspacePath: process.env.CONDUCTOR_WORKSPACE_PATH!,
  // appLabel?: 'Acme'   // audit name, defaults to `name`
});
```

`projects.bind()` is **idempotent on `(daemonHost, workspacePath)`** — it
find-or-creates, so it's safe to call on every boot. Other reads:
`client.projects.list()`, `client.projects.get(projectId)`.

> Persist `project.id` on your user/org record — it's stable forever. Don't
> re-bind per request if you can cache the id.

### 4.3 Create / read tasks

```ts
const task = await client.tasks.create({
  projectId: project.id,
  title: 'Investigate billing anomaly',
  initialMessage: 'Look at the last 24h of charges.', // optional kickoff prompt
  // backendType?: 'claude_code' | 'codex' | ...,     // engine override
  // metadata?: { ... },
});

await client.tasks.get(taskId);
await client.tasks.list({ projectId, status: 'running' });
```

### 4.4 Send a follow-up message

```ts
await client.tasks.sendMessage(taskId, 'drill into the top charge');
// or the object form:
await client.tasks.sendMessage(taskId, {
  content: 'drill in',
  clientRequestId: crypto.randomUUID(), // idempotency key (auto-generated if omitted)
  role: 'user',                          // see §7.2
  metadata: { ... },
});
```

### 4.5 Read history (pagination)

```ts
const page = await client.tasks.history(taskId, { limit: 50, beforeId });
// → { messages: Message[], hasMoreBefore: boolean, oldestMessageId: string | null }
```

### 4.6 Subscribe to events

`subscribe()` is an `AsyncIterable<ChatEvent>`. The first call lazily opens
`/ws/app`; later calls share the socket.

```ts
for await (const evt of client.tasks.subscribe(taskId, { signal })) {
  switch (evt.type) {
    case 'message_appended': console.log(evt.message.content); break;
    case 'message_updated':  /* re-render */ break;
    case 'runtime_status':   /* evt.status.statusLine, replyInProgress, ... */ break;
    case 'task_finished':    return;
    case 'task_failed':      throw new Error(evt.error.message);
    case 'connection_state': /* 'connected' | 'reconnecting' | 'offline' */ break;
  }
}
```

**History catch-up is on by default.** When a terminal event arrives
(`task_finished` / `task_failed`, `runtime_status` flipping `replyInProgress`
true→false, or a reconnect), the SDK pulls a recent history window over REST
and injects any missing messages as synthetic `message_appended` events. This
compensates for deployments where the realtime broadcast occasionally drops an
envelope (multi-instance fan-out, commit retries, momentary WS drops). Pass
`{ disableHistoryCatchUp: true }` to get only the raw realtime stream.

### 4.7 Stream the AI reply (`streamReply`)

Higher-level convenience that yields only reply deltas:

```ts
for await (const d of client.tasks.streamReply(taskId, { idleTimeoutMs: 0 })) {
  if (d.type === 'text')  process.stdout.write(d.text); // cumulative preview chunk
  if (d.type === 'done')  break;                        // d.message = full reply
  if (d.type === 'error') throw new Error(d.error.message);
  // d.type === 'status' → RuntimeStatus updates
}
```

- `text` deltas are **cumulative preview** chunks (built from
  `runtime_status.reply_preview`), not raw token streaming. `done` carries the
  final assistant `Message`.
- Default **120s idle timeout** between deltas; pass `idleTimeoutMs: 0` to
  disable for backends that can legitimately go silent for minutes.

### 4.8 Interrupt, restart & close

```ts
await client.tasks.interrupt(taskId, { targetReplyTo: replyMessageId });
await client.tasks.restart(taskId, { restartMode: 'refresh_session' }); // restart the AI session
await client.close(); // release the WS on shutdown (idempotent)
```

### 4.9 Errors

Every SDK throw is a `ConductorAppError` with a stable `code`:

```ts
import { isConductorAppError } from '@love-moon/app-sdk';

try { await client.tasks.create(...); }
catch (err) {
  if (isConductorAppError(err)) {
    // err.code, err.status, err.message, err.details, err.requestId
  }
}
```

Common codes: `unauthorized`, `forbidden`, `token_revoked`, `invalid_input`,
`project_not_found`, `task_not_found`, `daemon_offline`,
`workspace_path_conflict`, `task_not_running`,
`task_type_not_messageable`, `task_type_not_interruptible`, `network_error`,
`timeout`, `rate_limited`, `server_error`, `subscribe_failed`,
`stream_aborted`. The vocabulary is open (new codes are additive, minor bumps).

---

## 5. Browser widget integration (`/react`)

### 5.1 Mount the widget

```tsx
import { ChatView, createRestAdapter } from '@love-moon/app-sdk/react';
import '@love-moon/app-sdk/react/styles.css';   // required once, globally

// Create the adapter ONCE (module scope) — see the caveat in §7.8.
const adapter = createRestAdapter({ baseUrl: '/api/conductor' }); // your BFF

export default function ChatPage({ taskId }: { taskId: string }) {
  return <ChatView taskId={taskId} adapter={adapter} autoFocus />;
}
```

The widget never sees the Conductor token. It speaks to `baseUrl` (your BFF).
Full demo: [`examples/02_bff/app/page.tsx`](../../modules/app-sdk/examples/02_bff/app/page.tsx).

### 5.2 The BFF contract — routes the default adapter calls

`createRestAdapter` expects these routes under `baseUrl`:

| Route | Forward to (server SDK) |
| --- | --- |
| `GET  /tasks/:id/messages?pagination=1&limit=N&before_id=…` | `client.tasks.history()` → `{ messages, pagination: { has_more_before, oldest_message_id } }` |
| `POST /tasks/:id/messages` (`{ content, role?, clientRequestId?, metadata? }`) | `client.tasks.sendMessage()` |
| `POST /tasks/:id/interrupt` (`{ target_reply_to }`) | `client.tasks.interrupt()` |
| `GET  /tasks/:id/events` (`text/event-stream`) | `client.tasks.subscribe()` bridged to SSE |
| `POST /tasks/:id/restart` (`{ restart_mode? }`) — **only when `enableRestart`, see §7.3** | `client.tasks.restart()` |

The only non-trivial piece is the **SSE bridge** over `subscribe()` (~30
lines: stream `data: <JSON ChatEvent>\n\n`, send keep-alive comments, abort the
iterator on client disconnect). Copy it verbatim from
[`examples/02_bff/app/api/conductor/[...path]/route.ts`](../../modules/app-sdk/examples/02_bff/app/api/conductor/[...path]/route.ts).

`EventSource` can't send custom headers — the widget relies on cookies
(`credentials: 'include'` by default) for SSE auth, so authenticate the
*user's* session at the BFF, not via a bearer token in the browser.

---

## 6. Component & API reference (`/react`)

### 6.1 `<ChatView />` — the composed widget (recommended)

```tsx
<ChatView
  taskId={taskId}            // required
  adapter={adapter}          // required: a ChatAdapter (usually createRestAdapter)
  labels={{ send: '发送' }}  // i18n overrides (Partial<ChatViewLabels>) — §6.2
  theme={{ accent: '#e4572e' }} // CSS-variable overrides — §6.3
  layout="auto"              // 'desktop' | 'mobile' | 'auto'
  readOnly={false}           // disable the composer
  autoFocus={false}          // focus composer on mount / task switch
  showAppOriginChip={false}  // show "via {app}" on app-authored messages — §7.6
  renderMessageContent={(m) => <ReactMarkdown>{m.content}</ReactMarkdown>} // §7.4
  onError={(e) => console.error(e)}
  className="my-chat"
/>
```

`<ChatView>` composes `RuntimeStatusBar` + `MessageList` + `MessageInput`
inside a `<ChatProvider>`. State is isolated per instance — multiple
`<ChatView>`s on one page each own their state.

### 6.2 Labels (`ChatViewLabels`) — full list & i18n

Pass `labels` to localize. Any omitted key falls back to English. Full set:

```
statusThinking, statusToolCall, statusAwaitingUser, statusDone,   // runtime bar
inputPlaceholder, send, interrupt,                                // composer
restart, restartPending,                                          // restart UI
loadEarlier,                                                      // history
copy, copied, resend,                                             // bubble menu
scrollToBottom, jumpToQuestion,                                   // navigation (aria)
emptyTitle, emptyBody                                             // empty state
```

### 6.3 Theme (`ChatViewTheme`) — CSS variables

`theme` maps to CSS variables set on the root element. Well-known keys:
`accent`, `background`, `bubbleUser`, `bubbleAssistant`. Any other key
`fooBar` becomes `--foo-bar`. You can also override any `conductor-*` class in
your own CSS — the widget ships plain, semantic class names (not Tailwind), so
restyling never requires a fork. Variables available on
`.conductor-chat-view`: `--accent`, `--conductor-paper`, `--conductor-text`,
`--conductor-text-muted`, `--conductor-bubble-user`,
`--conductor-bubble-assistant`, `--conductor-border`, `--conductor-radius`,
`--conductor-spacing`, `--conductor-font`.

### 6.4 Built-in widget UX

Out of the box `<ChatView>` provides (parity with the main Conductor chat):

- **Anchor navigation** — a vertical dot rail to jump between your own
  messages; appears when scrolling up in a multi-question conversation.
- **Scroll-to-bottom button** — floating "jump to latest" when scrolled away.
- **Double-click / double-tap / Enter-Space action menu** — a bottom sheet
  with **Copy**, **Resend** (your messages), **Interrupt** (while a reply is
  in progress), **Restart** (when the adapter supports it — §7.3).
- **Timestamps** — revealed on hover (desktop) or single tap (touch).
- **Attachments** — image / video / audio / file rendering (§7.5).
- **Composer**: draft persistence per task, **↑/↓** to recall previous
  prompts, auto-grow, IME-safe sending. Key bindings in §7.7.
- **Infinite history** — scroll to top auto-loads older messages and anchors
  the viewport so content doesn't jump.
- **Scroll-position persistence** — per-task scroll + stick-to-bottom restored
  on remount / task switch.
- **Runtime status bar** + connection-state indicator.

### 6.5 `createRestAdapter(options)`

```ts
createRestAdapter({
  baseUrl: '/api/conductor',  // required
  authToken: '…' | async () => '…', // optional Bearer for REST (NOT used for SSE)
  credentials: 'include',     // cookies for REST + SSE (default 'include')
  fetch: customFetch,         // optional
  eventSource: PolyfillES,    // optional EventSource ctor (SSR/Node)
  timeoutMs: 30_000,          // per-request timeout
  enableRestart: false,       // opt into restart UI + POST /tasks/:id/restart — §7.3
});
```

### 6.6 `ChatAdapter` — bring your own wire format

If you don't use a Conductor-shaped BFF, implement `ChatAdapter` directly:

```ts
interface ChatAdapter {
  fetchHistory(taskId, opts?): Promise<{ messages; hasMoreBefore; oldestMessageId }>;
  subscribe(taskId, handler): { unsubscribe(): void };  // push ChatEvents to handler
  sendMessage(taskId, input): Promise<Message>;
  interrupt(taskId, { targetReplyTo }): Promise<void>;
  restart?(taskId, { restartMode? }): Promise<void>;     // optional — gates restart UI
  uploadAttachment?(taskId, file, opts?): Promise<{ id; url }>; // optional
}
```

Only `restart`/`uploadAttachment` are optional. If `restart` is absent the
widget hides all restart affordances.

### 6.7 Compose your own layout — `useChat()` / `<ChatProvider>`

For a custom UI, wrap your tree in `<ChatProvider taskId adapter onError>` and
read state/actions with `useChat()`:

```ts
const {
  state,            // ChatState (see below)
  taskId, adapter,
  send,             // (content, { metadata? }) => Promise<void>  — optimistic
  interrupt,        // () => Promise<void>
  loadEarlier,      // () => Promise<void>
  restart,          // ({ restartMode? }) => Promise<void>  — no-op if unsupported
  restartSupported, // boolean
} = useChat();
```

`ChatState`: `messages`, `pendingByClientId`, `runtime`, `connectionState`
(`'connected' | 'reconnecting' | 'offline'`), `hasMoreBefore`,
`oldestMessageId`, `loadingHistory`, `error`, `latestReplyId`.

The provided sub-components (`<MessageList>`, `<MessageInput>`,
`<RuntimeStatusBar>`) also work standalone **inside** a `<ChatProvider>`:

- `<MessageList labels renderMessageContent? showAppOriginChip? />`
- `<MessageInput labels disabled? autoFocus? />`
- `<RuntimeStatusBar labels />`

---

## 7. Notes & caveats

### 7.1 Security — the token is account-equivalent

Never put the Conductor token in a browser bundle or hand it to untrusted
code. It lives only in your BFF/server. The widget authenticates the *user* to
your BFF (cookie/JWT); the BFF authenticates to Conductor with the token.

### 7.2 The BFF is a trust boundary — hardcode `role`, strip `audit`

On `POST /tasks/:id/messages`, **do not trust the browser** to set `role` or
`metadata.audit`:

- Hardcode `role: 'user'`. Allowing `system`/`assistant` would let a client
  forge AI replies in the transcript.
- Strip `metadata.audit` before forwarding. Allowing `audit.actor='app'` would
  let a browser message masquerade as a server-side app message and defeat
  `streamReply`'s SDK-echo filter.

The SDK stamps its own audit fields server-side. See the example route's
threat-model comment.

### 7.3 Restart is opt-in (default off)

Restart UI is **hidden by default**. `createRestAdapter` only implements
`restart()` when you pass `enableRestart: true`; without it `restartSupported`
is false and `<ChatView>` shows no restart affordances. This prevents a restart
button that 404s against a BFF that only wired the four core routes.

To enable restart end-to-end:

1. Turn it on in the adapter:

   ```ts
   const adapter = createRestAdapter({ baseUrl: '/api/conductor', enableRestart: true });
   ```

2. Implement the BFF route, forwarding to the first-class server method:

   ```ts
   // POST /tasks/:id/restart
   await client.tasks.restart(taskId, { restartMode: body.restart_mode ?? 'refresh_session' });
   ```

`client.tasks.restart()` posts to Conductor's `POST /api/tasks/:id/restart`.
See [`examples/02_bff`](../../modules/app-sdk/examples/02_bff) — it enables
restart and wires the route. To **keep restart hidden**, simply leave
`enableRestart` unset (or, for a custom adapter, omit the `restart` method).

### 7.4 Markdown / Mermaid is intentionally not bundled

The widget renders **plain text** by default to keep the bundle lean and avoid
deciding which markdown library wins. Wire your own via `renderMessageContent`:

```tsx
<ChatView … renderMessageContent={(m) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
)} />
```

The SDK still owns the bubble container (alignment, pending state, data
attributes); only the inner content is replaced.

### 7.5 Attachment shape

`Attachment` carries `{ id, filename, mimeType, sizeBytes, url }`. The widget
derives the render kind (image/video/audio/file) from `mimeType`. `url` must be
a directly fetchable URL (your BFF resolves any signed/relative URL before
returning history). Sending attachments requires an adapter that implements
`uploadAttachment` and a backend that accepts `attachmentIds`.

### 7.6 `showAppOriginChip`

When true, messages with `metadata.audit.actor === 'app'` render a
"via {appDisplayName}" chip. The main Conductor app sets this true to label
other apps' messages; a third-party host embedding the widget in its *own* app
should leave it false to avoid a "via <self>" loop.

### 7.7 Composer key bindings & IME

- **Enter** (and **Shift+Enter**) → send.
- **Cmd/Ctrl+Enter** → newline.
- **↑ / ↓** (no modifiers) → browse previously-sent prompts.
- **Esc** (empty composer) → interrupt the in-flight reply.
- Sending is suppressed mid-IME-composition (Chinese/Japanese/Korean input).

Drafts persist per task in `sessionStorage`; scroll position too. These keys
match the main Conductor composer.

### 7.8 Create the adapter once

`<ChatProvider>` keys its subscribe effect on `taskId` only, so passing a fresh
adapter object on every render is safe (no re-subscribe loop). Still, prefer a
**module-scope** or `useMemo`'d adapter. To swap adapters mid-conversation,
remount with a new React `key` or change `taskId`.

### 7.9 Connection resilience

Both the server `subscribe()` and the widget store run **history catch-up**
after terminal/reconnect events, so a dropped realtime envelope (e.g. the final
assistant message) is recovered without a manual refresh. The reducer dedupes
by message id, so re-delivered messages never double-render.

### 7.10 Lifecycle

- Server: keep one `AppClient`; `await client.close()` on shutdown. Forgetting
  to close leaks a socket but loses no data.
- SSE bridge: abort the `subscribe()` iterator when the HTTP request aborts, or
  you leak a WS subscription per disconnected browser. Send keep-alive comments
  (~15s) so proxies don't kill idle streams.

---

## 8. Local development & testing

```bash
cd modules/app-sdk
pnpm install
pnpm build         # tsup bundles + copies styles.css
pnpm test          # vitest: /server (node) + /react (jsdom) suites
pnpm typecheck
pnpm test:bundle   # static guard: no Node code in /react, no DOM in /server
```

Run the examples end-to-end:

- CLI: copy [`examples/01_example/.env.example`](../../modules/app-sdk/examples/01_example) → `.env`, then `node chat-cli.mjs`.
- BFF + widget: copy [`examples/02_bff/.env.example`](../../modules/app-sdk/examples/02_bff) → `.env.local`, then `npm run dev`.

---

## 9. Quick type reference

| Type | Key fields |
| --- | --- |
| `Project` | `id`, `name`, `daemonHost`, `workspacePath`, `createdByApp`, … |
| `Task` | `id`, `projectId`, `title`, `status`, `backendType`, `sessionId`, … |
| `Message` | `id`, `taskId`, `role` (`user`/`sdk`/`assistant`/`system`/…), `content`, `metadata`, `attachments`, `createdAt` |
| `RuntimeStatus` | `state`, `statusLine`, `statusDoneLine`, `replyInProgress`, `replyTo`, `tokenUsagePercent`, … |
| `ChatEvent` | `message_appended` \| `message_updated` \| `runtime_status` \| `task_finished` \| `task_failed` \| `connection_state` |
| `StreamReplyDelta` | `text` \| `status` \| `done` \| `error` |
| `ConductorAppError` | `code`, `status?`, `message`, `details?`, `requestId?` |

For the full design rationale, see
[RFC 0027](../rfc/0027-feature-conductor-app-sdk.md).

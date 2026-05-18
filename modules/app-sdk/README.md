# @love-moon/app-sdk

Embed Conductor AI tools into third-party apps. One npm package, three
subpath entries:

| Entry | Environment | Purpose |
| --- | --- | --- |
| `@love-moon/app-sdk` | any | Pure types + `SDK_VERSION`. Safe everywhere. |
| `@love-moon/app-sdk/server` | Node 18+ | SDK for third-party **backends** to talk to Conductor REST + `/ws/app`. |
| `@love-moon/app-sdk/react` | browser / React 18+ | Chat widget (`<ChatView />`) wired by a `ChatAdapter`. |

See [RFC 0027](../../claw/rfc/0027-feature-conductor-app-sdk.md) for the design.

## Examples

Two runnable examples ship with the package, under [`examples/`](./examples/):

| Example | Lines | What it shows |
| --- | --- | --- |
| [`examples/01_example/`](./examples/01_example/) | ~35 LOC | **Smallest possible app.** Pure Node CLI: bind project → create task → stream the AI reply to stdout. Use this to learn the SDK in 60 seconds. |
| [`examples/02_bff/`](./examples/02_bff/) | ~120 LOC | Full-stack: Next.js BFF + React `<ChatView />` widget + SSE bridge over `/ws/app`. Use this as a template for real browser integrations. |

## Quick start

A complete integration is ~120 lines of business code spread across a Next.js
BFF and a React page. See [`examples/02_bff/`](./examples/02_bff/) for the
full runnable demo, or [`examples/01_example/`](./examples/01_example/) for
a pure-Node CLI.

### Backend (the only place your Conductor token lives)

```ts
// lib/conductor.ts
import { connect } from '@love-moon/app-sdk/server';

export const client = await connect({
  baseUrl: 'https://conductor.example.com',
  bearerToken: process.env.CONDUCTOR_TOKEN!,
});

export async function bindProject() {
  return client.projects.bind({
    name: 'Acme Dashboard',
    daemonHost: process.env.CONDUCTOR_DAEMON_HOST!,
    workspacePath: process.env.CONDUCTOR_WORKSPACE_PATH!,
  });
  // Idempotent: matches by (daemonHost, workspacePath); creates only on miss.
}

// Create a task once you've got the project id. `initialMessage` is the
// kickoff prompt — the AI reply to that message starts streaming as soon
// as you subscribe below.
const task = await client.tasks.create({
  projectId: project.id,
  title: 'Investigate billing anomaly',
  initialMessage: 'Look at the last 24h of charges.',
});

// Subscribe to receive the AI's reply (and any subsequent events on the
// task). Use `sendMessage` to add follow-up turns from your code; the demo
// here shows a single-turn flow, so we just consume events until the task
// finishes. To send a follow-up turn before exiting, call
// `client.tasks.sendMessage(task.id, 'drill into the top one')` and keep
// the loop running.
for await (const evt of client.tasks.subscribe(task.id)) {
  if (evt.type === 'message_appended') console.log(evt.message.content);
  if (evt.type === 'task_finished') break;
}

// streamReply: stream the AI's reply as it builds up. Defaults to a 120s
// idle timeout between deltas; pass `idleTimeoutMs: 0` to disable for
// long-running backends that may legitimately go silent for minutes.
for await (const delta of client.tasks.streamReply(task.id, { idleTimeoutMs: 0 })) {
  if (delta.type === 'text') process.stdout.write(delta.text);
  if (delta.type === 'done') break;
  if (delta.type === 'error') throw new Error(delta.error.message);
}
```

### Frontend (chat widget)

```tsx
import { ChatView, createRestAdapter } from '@love-moon/app-sdk/react';
import '@love-moon/app-sdk/react/styles.css';

const adapter = createRestAdapter({
  baseUrl: '/api/conductor',          // your BFF, not Conductor directly
});

export default function ChatPage({ taskId }: { taskId: string }) {
  return <ChatView taskId={taskId} adapter={adapter} />;
}
```

### Backend-for-Frontend (the 4 routes the widget speaks)

The widget's default `createRestAdapter` expects:

| Route | Forward to |
| --- | --- |
| `GET  /tasks/:id/messages?pagination=1&limit=N&before_id=...` | `client.tasks.history()` |
| `POST /tasks/:id/messages` | `client.tasks.sendMessage()` |
| `POST /tasks/:id/interrupt` | `client.tasks.interrupt()` |
| `GET  /tasks/:id/events` (text/event-stream) | `client.tasks.subscribe()` via SSE bridge |

The SSE bridge over Conductor's `/ws/app` is the only non-trivial piece —
~30 lines of code. See the
[example catch-all route](./examples/02_bff/app/api/conductor/[...path]/route.ts)
for the full pattern.

## Why a single package, three entries

The widget and the BFF must agree on wire format and event shapes; coupling
them in a single package + shared types makes that contract impossible to
accidentally split. Subpath exports + `peerDependenciesMeta.optional = true`
ensure server-only consumers don't pay for React, and browsers never see Node
code. See [Option F in the RFC](../../claw/rfc/0027-feature-conductor-app-sdk.md#proposed-design).

## Security model

The token used by `@love-moon/app-sdk/server` is equivalent to the user's
Conductor account. **Never** put it in a browser bundle or expose it to
untrusted code. The intended deployment is:

```
[browser widget] ──▶ [your BFF, holds token] ──▶ [Conductor backend] ──▶ [daemon]
```

The widget never receives the Conductor token — it talks only to your BFF.

## Status

| Milestone | Status |
| --- | --- |
| M0 — package skeleton + exports + bundle smoke | ✓ |
| M1 — `/server` REST + WS subscribe + streamReply + tests | ✓ |
| M2 — `/react` widget + default REST adapter + integration tests | ✓ |
| M3 — `examples/01_example` CLI + `examples/02_bff` Next.js demo + this README | ✓ |

The v0.1 widget is intentionally minimal in visuals — the eventual physical
extraction of the polished UI from `web/src/features/chat` (RFC §4) is a
future PR. The widget's component API + adapter contract are stable now.

## Development

```bash
cd modules/app-sdk
npm install           # via root npm workspaces
npm run build         # tsup + Tailwind copy
npm test              # vitest: unit + integration tests across node + jsdom
npm run typecheck
npm run test:bundle   # static guard: no Node code in /react, no DOM in /server
```

### Project layout

```
src/
  types/            Pure types — Task / Message / RuntimeStatus / ChatEvent / ChatAdapter / errors
  index.ts          Root entry (re-exports types)
  server/           Node-only: connect() / AppClient / projects.bind / tasks.* / ws subscribe / streamReply
  react/            Browser-only: <ChatView />, components, default REST adapter, styles
test/
  server/           node-env tests (fetcher, projects, tasks, subscribe, streamReply)
  react/            jsdom-env tests (<ChatView /> integration)
```

### Versioning policy

- 1.x freezes `<ChatView>` props, `AppClient` methods, `ChatAdapter` interface,
  and root type exports.
- Adding a new `ChatEvent` variant or a new SDK method is a minor bump.
- Removing or renaming any of the above is a major bump.

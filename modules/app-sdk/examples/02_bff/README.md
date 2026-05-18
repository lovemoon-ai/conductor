# Conductor App SDK — end-to-end demo

A tiny Next.js app that uses `@love-moon/app-sdk` to embed a chat with a
user's Conductor AI tool. **Total business code: ~120 lines.**

```
┌─────────────────┐      ┌─────────────────┐      ┌──────────────────────┐
│  browser:       │      │  /api/conductor │      │  Conductor backend   │
│  <ChatView />   │ ──── │  Next.js BFF    │ ──── │  + /ws/app + daemon  │
│  + REST adapter │ SSE  │  app-sdk/server │      │                      │
└─────────────────┘      └─────────────────┘      └──────────────────────┘
```

## Run it

```bash
# 1. Build the SDK (the example uses file: link to ../..).
cd ../.. && npm run build && cd -

# 2. Install + start.
npm install
cp .env.example .env.local
$EDITOR .env.local          # fill in CONDUCTOR_TOKEN + DAEMON_HOST + WORKSPACE_PATH
npm run dev                 # → http://localhost:3001
```

You need a running Conductor backend (typically `http://localhost:6152` via
`cd web && pnpm dev`) and an online daemon (typically `make debug-cli`).

## What it shows

| File | Concern |
| --- | --- |
| `lib/conductor.ts` | Server-side singleton `AppClient`; `projects.bind()` to find-or-create the demo project (idempotent). |
| `app/api/conductor/bind/route.ts` | Page bootstrap: bind project + create a fresh task; return ids. |
| `app/api/conductor/[...path]/route.ts` | Catch-all BFF that forwards 4 routes to Conductor:<br>• `GET /tasks/:id/messages` → `tasks.history()`<br>• `POST /tasks/:id/messages` → `tasks.sendMessage()`<br>• `POST /tasks/:id/interrupt` → `tasks.interrupt()`<br>• `GET /tasks/:id/events` → SSE bridge over `tasks.subscribe()` |
| `app/page.tsx` | React page: bootstrap, mount `<ChatView />`. |

The SSE bridge (~30 lines in the catch-all) is the most interesting piece —
that's how the SDK's server-side AsyncIterable becomes a client-side
EventSource without needing a custom Next.js server.

## What it deliberately skips

- **End-user authentication**: the BFF trusts the local browser session. A
  real app would gate every route behind its own auth (cookie / JWT).
- **Persistence**: every page load creates a new task. A real app would
  persist `(userId, taskId)` somewhere and resume.
- **CSRF protection**: standard Next.js patterns apply, not shown here.
- **Rate limiting**: trivial to add at the BFF (per user / per IP).

These are intentionally out of scope — they're host application concerns,
not SDK concerns.

## Common errors

| Symptom | Cause |
| --- | --- |
| `Missing env var CONDUCTOR_TOKEN` on bind | `.env.local` not configured. |
| Bind returns `daemon_offline` | Daemon at `CONDUCTOR_DAEMON_HOST` isn't running. Start the daemon (`make debug-cli` for dev). |
| Bind returns `binding_validation_failed` | Daemon doesn't recognize the `CONDUCTOR_WORKSPACE_PATH`. Use a path the daemon has already reported. |
| SSE silently disconnects after ~30s | Reverse proxy buffering. The response sets `X-Accel-Buffering: no`; check your proxy config. |
| `401 unauthorized` | Token revoked or invalid. Mint a new one in Conductor Settings → API Tokens. |

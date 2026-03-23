# Conductor

[Website](https://conductor-ai.top/) · [Docs](https://conductor-ai.top/docs/)

Conductor is an open-source control plane for AI coding agents.

Run agents locally. Keep data on your machine. Control everything from anywhere. Access remote terminals when you need them.

It includes:
- a web app for tasks and projects
- a cli and daemon for running agents on local machines
- SDKs for backend, realtime, and session integration

Conductor connects your task system with coding agents such as Codex, Claude, and OpenCode, making agent execution visible, connected, and manageable in one place.

## Who it's for

Conductor is built for people who want to run multiple coding agents without giving up local control:

- founders and engineers running several agent sessions in parallel
- teams that want a shared task view over local agent execution
- operators who need remote visibility into agent state, logs, and terminals

## How it works

Typical flow:

1. Create a task in the web app or CLI.
2. A local `conductor daemon` claims the task and starts the configured agent runtime.
3. The web app receives realtime task status, messages, and terminal events.
4. You can inspect progress, replay context, or attach to the remote terminal when needed.

This keeps execution local while giving you a shared control plane for orchestration and observability.

## Self-host

For a minimal self-hosted setup:

1. Set up `web/.env.production.local` with your domain, database, and integration secrets.
2. On the server, run `cd web && pnpm install && pnpm db:generate && pnpm db:push && pnpm build && pnpm start`.
3. Bootstrap the first web login without SMS if needed:
   - `cd web && pnpm bootstrap:self-host --phone +8613800138000 --base-url https://your-domain.com`
   - open the printed `Login URL` once in the browser
4. On each machine that will run agents, run `conductor config`, then `conductor daemon`.

## Packages

- `web/` — Next.js app and API server
- `cli/` — `conductor` CLI and daemon
- `modules/conductor-sdk/` — shared backend and realtime SDK
- `modules/ai-sdk/` — AI backend adapters

## Architecture entry points

- `claw/architecture/README.md` — durable package map and architecture notes
- `claw/architecture/ai-sdk.md` — local AI runtime architecture
- `web/README.md` — web app setup, database, and local server workflow

## Development

See [`web/README.md`](./web/README.md) for local setup.

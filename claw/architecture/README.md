# Architecture Notes

Use this folder for durable technical notes that explain how the monorepo fits
together.

Current package map:

- `web/`: application UI, API routes, WebSocket entrypoints, and Prisma schema
- `cli/`: published CLI and daemon entrypoints
- `modules/ai-sdk/`: local AI session abstraction and provider adapters
- `modules/conductor-sdk/`: SDK contracts shared by clients and backends
- `modules/volc-sms/`: SMS provider integration
- `scripts/`: deployment, release, and migration helpers

Document here when the note is more stable than a sprint, such as:

- session lifecycle diagrams
- auth and backend interaction boundaries
- module ownership and public interfaces
- deployment topology
- cross-package data flow

Avoid putting sprint planning or issue state here. That belongs in Linear.

Available notes:

- `ai-sdk.md`: codex app-server runtime architecture for the local AI session layer
- `task-fire-daemon.md`: current source of truth for `ai_task` / daemon / fire ownership, routing, and restart semantics

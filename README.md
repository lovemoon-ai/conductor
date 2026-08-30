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

## CLI data directory

By default, the CLI stores user-level configuration and runtime data in
`~/.conductor`. Set `CONDUCTOR_HOME` to use a different directory:

```bash
export CONDUCTOR_HOME=/data/conductor/profile-a
conductor config
conductor daemon
```

This relocates `config.yaml`, `config-ai-serve.yaml`, daemon logs, Fire locks,
session records, version metadata, and AI manager caches. Config
resolution uses this precedence:

1. `--config-file <path>`
2. `CONDUCTOR_CONFIG`
3. `$CONDUCTOR_HOME/config.yaml`
4. `~/.conductor/config.yaml`

Project-scoped `.conductor/settings.yaml`, `.conductor/worktrees/`, Fire task
markers, and durable project state remain inside each project and are not
relocated.

### Task worktree timeouts

When a task is created with several agents and `worktree` enabled, all of its
tasks share one worktree. The first agent creates it; the others wait for it
rather than racing to create the same branch. Both waits are bounded and can be
tuned per daemon:

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONDUCTOR_WORKTREE_REUSE_WAIT_TIMEOUT_MS` | `180000` (3 min) | How long a waiting task will wait for the shared worktree to be fully prepared. |
| `CONDUCTOR_WORKTREE_REUSE_POLL_INTERVAL_MS` | `250` | How often it re-checks while waiting. |

The default ceiling has to cover a cold checkout plus submodule sync. On a large
repository — or a slow network — the waiting tasks can hit it and fail to start
with `Timed out waiting for shared git worktree ...`; raise
`CONDUCTOR_WORKTREE_REUSE_WAIT_TIMEOUT_MS` on that daemon if so. The same error
also appears when the creating task itself failed midway through preparation,
in which case the fix is to look at that task, not the timeout.

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

## Releases

Web deploys and npm releases are separate tracks. Web-only changes deploy the
`web/` app with a deploy identifier such as the commit SHA; they do not require
an npm version.

Published npm packages use changesets. For user-visible changes under `cli/` or
the published `modules/*` packages, run:

```bash
npm run changeset
```

Commit the generated `.changeset/*.md` file with the PR. After merge, the
`Release Packages` workflow opens a `version packages` PR. Merging that PR
publishes the affected npm packages through npm trusted publishing. If the CLI
package is released, the workflow also dispatches the CLI archive release.

See [`claw/sop/06_release.md`](./claw/sop/06_release.md) for the full release
process.

# Minimal CLI example

The smallest possible app using `@love-moon/app-sdk`. About **35 lines of
business code** to:

1. Connect to a Conductor backend with a user token.
2. Find-or-create a project bound to a daemon + workspace.
3. Create an AI task.
4. Read one prompt from stdin, send it, stream the AI reply to stdout.

Pure Node — no React, no BFF, no web server. Use this to learn what the SDK
does end-to-end before integrating it into your own app.

> For a full-stack browser demo (BFF + React widget + SSE bridge), see
> the sibling [`../02_bff/`](../02_bff/).

## Setup

```bash
# 1. Build the SDK so the file: dependency resolves.
cd ../..  # → modules/app-sdk
npm install
npm run build

# 2. Install the example's local file: link.
cd examples/01_example
npm install

# 3. Configure.
cp .env.example .env
$EDITOR .env

# 4. Run. (Either source .env yourself or use a tool like dotenv-cli.)
export $(cat .env | grep -v '^#' | xargs)
npm start
```

Prerequisites: a running Conductor backend (default `http://localhost:6152`)
and an online daemon registered for the configured workspace.

## Sample session

```text
→ connecting to http://localhost:6152
→ binding project "App SDK CLI Example" on duino-mbp:/Users/me/work/acme
  project p_abc123 (reused)
You: list the three biggest files in this repo
→ creating task
  task t_xyz789

AI:
Sure — looking at the workspace…
1. web/src/app/api/projects/route.ts (998 lines)
2. web/src/lib/realtime/agent-gateway.ts (...)
3. ...
```

## What it deliberately doesn't do

- **No multi-turn loop**: sends one prompt and exits. A real CLI would loop
  on stdin with `client.tasks.sendMessage(taskId, content)` for each turn.
- **No interrupt UI**: nothing reads Ctrl+C to call `tasks.interrupt()`.
- **No error retry**: on transient `network_error` it just exits with code 1.

These are intentionally out of scope — the example is a teaching tool, not
a finished product. The SDK supports all of them; see `../../README.md`.

## Code walkthrough

[`chat-cli.mjs`](./chat-cli.mjs) is annotated inline. The four SDK calls
are:

```js
const client  = await connect({ baseUrl, bearerToken });
const project = await client.projects.bind({ name, daemonHost, workspacePath });
const task    = await client.tasks.create({ projectId: project.id, title, initialMessage });
for await (const delta of client.tasks.streamReply(task.id)) { /* … */ }
```

Everything else (env parsing, stdin readline, terminal output) is plain Node.

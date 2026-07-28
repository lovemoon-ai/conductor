---
name: conductor
description: >-
  Operate and explain the public Conductor CLI: bridge or resume local
  Codex/Claude sessions with `conductor fire`, create daemon-backed app tasks,
  manage projects/issues/tasks and scheduled messages, upload files, configure
  and diagnose daemons, connect Feishu channels with `conductor channel`, update
  the CLI, and run the OpenAI-compatible `conductor serve-ai` server. Use for requests involving any
  `conductor` command or moving terminal work into the Conductor app.
  Distinguish `fire` (foreground bridge or existing-session resume) from
  `task create` (fresh app task). Never summarize the current conversation into
  a new handoff prompt; only run a fresh prompt when the user supplied its text
  and explicitly asked to run it.
---

# Conductor

Use this skill for the public `conductor` command surface in this repo.

Reference docs in this skill:

- `reference/serve-ai.md`: `conductor serve-ai` usage, config fallback, startup commands, and `response_format` / output schema examples.
- `reference/entity-commands.md`: `conductor project|issue|task` — entity-oriented CRUD commands for AI / CI / scripting. Covers app-task creation, global flags (`--json`, `--dry-run`, `--project`), exit codes, project resolution priority, the `metadata.audit` audit boundary, idempotency via `--client-request-id`, and the core RFC 0025 scenarios.

## First Decide The Intent

Classify the request before doing any prep work:

1. **Direct command / resume intent**: the user already gave a concrete `conductor fire ...` command, explicitly asked for `conductor fire --resume <session-id>`, or clearly wants to reconnect to an existing backend session.
   - Prefer running or explaining that exact command path directly.
   - Do **not** first turn it into a handoff workflow.
   - Do **not** generate any new handoff prompt from conversation context.
2. **New app-task intent**: the user explicitly asks for `conductor task create`, wants a new task launched by an online daemon, or wants the new task grouped with a parent task in the app.
   - Use `conductor task create`, not `conductor fire`.
   - Require an explicit title; only pass prompt text supplied by the user.
3. **Entity intent**: the user wants to create, inspect, or update a project, issue, existing task, inserted message, or scheduled message.
   - Use `conductor project|issue|task`; this surface also includes fresh app-task creation.
4. **Operations / integration intent**: the user is asking about install, config, daemon, diagnosis, file upload, Feishu channel connection, `serve-ai`, update, or command syntax.
   - Inspect help/config as needed.

If the request is ambiguous, prefer **direct command / resume intent**.

## Guardrails

- Do **not** summarize the current conversation into a handoff prompt.
- Do **not** convert "use conductor to take over this task" into "organize the context and run `conductor fire -- "<handoff prompt>"`".
- Do **not** inspect CLI help or local config as a ritual before every Conductor request.
- Do **not** create a fresh Conductor task unless the user explicitly asked for one or explicitly provided the prompt to run.

Only run `conductor --help`, subcommand help, or read `~/.conductor/config.yaml` / `--config-file` when:

- the user asked for setup or troubleshooting,
- exact CLI syntax needs verification,
- the direct command failed and you need to debug why,
- or config-dependent behavior is actually relevant to the task.

## Choose The Right Tool

- install script: bootstrap the public CLI when `conductor` is not installed yet.
- `conductor send-file`: upload a local file into the active task session. This is the main path for AI-generated screenshots, videos, logs, JSON, and other artifacts.
- `conductor config`: bootstrap `~/.conductor/config.yaml` with browser device authorization by default, plus `agent_token`, `backend_url`, `daemon_name`, `workspace`, and `allow_cli_list`.
- `conductor fire`: run a coding CLI in the foreground and bridge it to a Conductor task.
- `conductor task create`: create a daemon-backed app task through the same server path as the web frontend. Use it for a fresh remote task, including parent task-card grouping; do not use it to attach or resume the current local coding session.
- `conductor project|issue|task`: manage entities, including messages, mid-turn inserts, schedules, and fresh app-task creation. See `reference/entity-commands.md`.
- `conductor daemon`: keep a desktop agent online so tasks created from the app can run remotely.
- `conductor diagnose <task-id>`: inspect a stuck or failed task and print likely root cause.
- `conductor channel connect feishu`: upload `channels.feishu` from the selected config file to the Conductor backend.
- `conductor serve-ai`: expose configured local AI backends through an OpenAI-compatible HTTP server. See `reference/serve-ai.md`.
- `conductor update`: check npm for a newer CLI version and install it.

## Core Workflows

### Resume An Existing Backend Session

When the user already has a backend session id and wants `conductor fire --backend <name> --resume <session-id>`, treat that as a direct resume workflow, not a handoff.

Default flow:

1. Use the backend the user specified, or `codex` if they explicitly referenced a Codex session.
2. Run or suggest the direct command:

```bash
conductor fire --backend <name> --resume <session-id>
```

3. Only inspect `conductor fire --help` or config if the command fails, the backend is unclear, or the user explicitly asks for validation/debugging.
4. Do **not** rewrite the current conversation into a new prompt for this case.
5. Do **not** create a new task unless the user explicitly asks for a fresh one.

### Install Or Repair The CLI

If `conductor` is missing, broken, or too old, prefer the public installer first:

```bash
curl -fsSL https://conductor-ai.top/install.sh | bash
conductor --version
```

If the user is developing this repo itself, the local developer path is `make install-cli`, which builds the CLI in place and writes a shim to `./bin/conductor-dev`. That shim is intentionally not added to the system PATH, so the system-wide `conductor` keeps coming from brew / the public install.sh.

### Send A File Back To The Task

Use `conductor send-file` whenever AI needs to attach a local artifact to the current Conductor task.

Typical payloads:

- screenshots and photos
- videos and screen recordings
- audio clips
- PDFs and documents
- logs, JSON, and text outputs

Prefer `conductor send-file` over raw API calls when the file already exists on disk.

```bash
conductor send-file ./screenshot.png --content "Current screenshot"
conductor send-file ./repro.mp4 --content "Video repro"
conductor send-file ./result.json --content "Parsed output" --json
conductor send-file ./artifact.png --task-id <task-id>
```

Important flags:

- `--task-id <id>` forces the upload into a specific task.
- `--content <text>` adds a message alongside the attachment.
- `--role <sdk|assistant|user>` controls the message role. Default is `sdk`.
- `--mime-type <type>` overrides extension-based MIME detection.
- `--name <filename>` overrides the displayed attachment name.
- `--json` returns structured output for tool chaining.

Task resolution order:

1. Explicit `--task-id`
2. `CONDUCTOR_TASK_ID`
3. Nearest `.conductor/state/active-fire.task_<id>.json`

If auto-detection fails, pass `--task-id` or run the command from an active `conductor fire` workspace.

### Bootstrap A Machine

Use `conductor config` first.
It now starts browser-based device authorization by default.
Use `--manual` or `--token` only when you need to skip that flow.

```bash
conductor config
conductor config --manual
conductor config --token <token>
conductor config --token <token> --force
```

Prefer reusing an existing `~/.conductor/config.yaml` when it is already valid.

If the user is signed in to the Conductor web app and explicitly wants the generated YAML, the backend endpoint is `POST /api/auth/config`.

Validate that `allow_cli_list` contains the installed coding CLIs:

```yaml
allow_cli_list:
  codex: codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check
  claude: claude --dangerously-skip-permissions
  opencode: opencode
  kimi: kimi
```

### Start A Foreground Task

Use `conductor fire` when the user wants to launch work from the current terminal session.

```bash
conductor fire -- "fix the bug"
conductor fire --backend codex -- "hi"
conductor fire --backend claude -- "add feature"
conductor fire --list-backends
conductor fire --backend codex --resume <session-id>
```

Key flags:

- `--backend <name>` selects a configured backend from `allow_cli_list`.
- `--title <text>` sets the task title shown in the app.
- `--resume <session-id>` resumes an existing backend session.
- `--config-file <path>` loads a non-default config.

For “continue this conversation on mobile” requests, prefer `--backend codex` unless the user asked for another backend.

### Create A Daemon-Backed App Task

Use `conductor task create` when the user wants a fresh app task dispatched through an online daemon rather than a foreground `fire` process.

```bash
conductor task create --title "Implement parser" --prompt "Build the parser" --backend codex
conductor task create --title "Follow-up" --prompt "Handle edge cases" \
  --parent-task-id <parent-task-id> --json
```

`--title` is required. `--parent-task-id` groups the new task with a visible, unarchived parent. The command creates an `ai_task`, requires a compatible online non-fire daemon, and never attaches the current local backend session. If JSON output reports `grouping.grouped: false`, the task already exists; do not retry creation. See `reference/entity-commands.md` for flags and failure semantics.

### Keep A Desktop Agent Online

Use `conductor daemon` when the user wants the desktop to receive tasks initiated from the app.

```bash
conductor daemon
conductor daemon --config-file ~/.conductor/config.yaml
conductor daemon --nohup
conductor daemon --nohup --force
conductor daemon --clean-all
```

Operational notes:

- `--nohup` backgrounds the daemon and writes logs to `~/.conductor/logs/`.
- `--force` restarts an existing daemon if a lock file already exists.
- `--clean-all` prunes stale daemon presence on the backend before starting.

### Diagnose A Broken Task

Use `conductor diagnose` for stuck, offline, or looping tasks.

```bash
conductor diagnose <task-id>
conductor diagnose <task-id> --json
```

Prefer `--json` when another tool needs structured output. Otherwise summarize the CLI verdict, key signals, and next actions for the user.

### Update The CLI

Use `conductor update` to check npm and upgrade the installed package.

```bash
conductor update
conductor update --yes
conductor update --force
```

If the built-in updater fails, fall back to the package-manager command shown by the CLI.

### Operate Entities (project / issue / task)

Use `conductor project|issue|task` for entity operations, including creating fresh daemon-backed app tasks. Use `fire` instead only when bridging the current foreground process or resuming an existing local backend session. The full surface lives in `reference/entity-commands.md`; the minimal forms to know:

```bash
# Project
conductor project list [--include-hidden]
conductor project current                              # prints id only — good for shell substitution
conductor project create [--workspace-path <p>] [--daemon-host <h>]
conductor project hide <id|name>

# Issue
conductor issue list [--status doing,backlog]
conductor issue create --title "<t>" [--priority P2] [--client-request-id <key>]
conductor issue start <id>                             # backlog → doing
conductor issue done  <id> [--evidence <text>|@FILE]   # doing → done, writes metadata.qa.evidence

# Task
conductor task create --title "<t>" [--prompt "<p>"] [--backend <name>] [--parent-task-id <id>]
conductor task send <id> "<message>"                   # or `--stdin` / `--from-file FILE`
conductor task insert <id> "<message>"                 # interrupt current turn, then run this message
conductor task messages <id> [--limit N]               # pulls a slice and exits — no --follow
conductor task schedule create <id> "<message>" --delay 10m
```

Rules of thumb when handling these:

- Add `--json` for AI / scripting; the human-readable form is for humans.
- Use `--dry-run` before any destructive or wide-blast write (especially `issue create` loops). It prints the would-be `method / url / body` and never hits the network.
- Pass `--client-request-id <key>` on batch `issue create` for idempotent retries. Same key + same project returns the existing issue.
- `--project <id|name>` overrides the cwd-based project resolution. When in doubt, capture it once: `PROJECT=$(conductor project current)`.
- Audit fields live under `metadata.audit.*` (RFC 0025 §5.2). Setting `CONDUCTOR_INVOKED_BY=<caller>` lands in `metadata.audit.invokedBy`. Top-level `actor`/`cliVersion`/`sdkVersion`/`invokedBy` in user metadata is silently stripped by the server.
- Exit codes: `0` ok, `1` generic, `2` args, `3` auth, `4` not found, `5` project unresolved.

## Task Context And Environment

These variables are the main hooks between CLI processes and task routing:

- `CONDUCTOR_HOME`: user data directory; defaults to `~/.conductor`.
- `CONDUCTOR_CONFIG`: config file override; takes precedence over `CONDUCTOR_HOME`.
- `CONDUCTOR_BACKEND`: default backend for `conductor fire`.
- `CONDUCTOR_PROJECT_ID`: attach `fire` to an existing project.
- `CONDUCTOR_TASK_ID`: attach `fire` to an existing task and let `send-file` auto-target that task.
- `CONDUCTOR_DAEMON_NAME`: override the daemon name without editing config.
- `CONDUCTOR_WS`: override the daemon workspace root.
- `CONDUCTOR_WS_URL`: override websocket endpoint when needed.
- `CONDUCTOR_CLI_POLL_INTERVAL_MS`: tune `fire` polling cadence.

When a child tool needs to report artifacts back into the active task, first make sure it inherits the current `CONDUCTOR_TASK_ID` or is launched from a `fire` or `daemon` flow that already provides task context. In most AI-facing cases, the next step should be `conductor send-file`.

## Boundaries

- Conductor cannot migrate hidden chat state byte-for-byte. Resume an existing backend session when possible; if a fresh task is required, use prompt text supplied by the user.
- If the installed CLI and the checked-out repo differ, trust `conductor --help` and `conductor send-file --help` before giving exact flags.
- `cli/bin/conductor-chrome.js` is an auxiliary browser automation helper, not a `conductor <subcommand>` entry in the main CLI help.
- Prefer the public `conductor ...` interface in user-facing guidance instead of invoking `cli/bin/*.js` directly, unless the user is developing the CLI itself.

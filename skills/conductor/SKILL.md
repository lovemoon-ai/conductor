---
name: Conductor
description: >-
  Operate the Conductor cli directly. Default to executing or explaining the
  exact `conductor` subcommand the user asked for, especially `conductor fire`,
  `conductor fire --backend <name> --resume <session-id>`, `conductor send-file`,
  `conductor daemon`, `conductor diagnose`, `conductor config`,
  `conductor update`, and the entity commands `conductor project|issue|task`.
  Strictly forbid the "handoff prompt" workflow: do not
  summarize the current Codex conversation into a new Conductor prompt, and do
  not convert user intent into a fresh `conductor fire -- "<prompt>"` task
  unless the user explicitly provided that prompt text and asked to run it.
---

# Conductor

Use this skill for the public `conductor` command surface in this repo.

Reference docs in this skill:

- `reference/serve-ai.md`: `conductor serve-ai` usage, config fallback, startup commands, and `response_format` / output schema examples.
- `reference/entity-commands.md`: `conductor project|issue|task` — entity-oriented CRUD commands for AI / CI / scripting. Covers global flags (`--json`, `--dry-run`, `--project`), exit codes, project resolution priority, the `metadata.audit` audit boundary, idempotency via `--client-request-id`, and the three core RFC 0025 scenarios (batch issue creation, QA → done, sending a message to a task).

Use it especially when the user says things like:

- "Just run `conductor fire --backend codex --resume <session-id>`"
- "Help me restore this Conductor / Codex session"
- "Why doesn't this command work: `conductor fire ...`"
- "Use `conductor send-file` to transfer this file back to the task"
- "Move the current conversation to the cloud / mobile so I can continue later"
- "Use conductor to take over this task"
- "Help me install and configure conductor, then send this conversation to my phone so I can continue there"
- "Start this in Conductor so I can continue from the app"
- "How do I use `conductor serve-ai`?"
- "How do I start the OpenAI-compatible server and set output schema?"
- "Create these issues in my current project with `conductor issue create`"
- "Mark this issue as done — QA passed, attach the report as evidence"
- "Send a follow-up message to task `<id>` from the command line"
- "List my projects / show which project this cwd resolves to / set this project as default"
- "Hide this old project from my list" / "show hidden projects too"

## First Decide The Intent

Classify the request before doing any prep work:

1. **Direct command / resume intent**: the user already gave a concrete `conductor fire ...` command, explicitly asked for `conductor fire --resume <session-id>`, or clearly wants to reconnect to an existing backend session.
   - Prefer running or explaining that exact command path directly.
   - Do **not** first turn it into a handoff workflow.
   - Do **not** generate any new handoff prompt from conversation context.
2. **Setup / diagnose / config intent**: the user is asking about install, config, daemon, diagnosis, update, or command syntax.
   - Inspect help/config as needed.

If the request is ambiguous, prefer **direct command / resume intent**.

## Hard Prohibition

- Do **not** summarize the current conversation into a handoff prompt.
- Do **not** convert "use conductor to take over this task" into "organize the context and run `conductor fire -- "<handoff prompt>"`".
- Do **not** inspect CLI help or local config as a ritual before every Conductor request.
- Do **not** create a fresh Conductor task unless the user explicitly asked for one or explicitly provided the prompt to run.
- For resume requests, prefer the direct command path and stop there.

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
- `conductor daemon`: keep a desktop agent online so tasks created from the app can run remotely.
- `conductor diagnose <task-id>`: inspect a stuck or failed task and print likely root cause.
- `conductor update`: check npm for a newer CLI version and install it.
- `conductor project|issue|task <sub>`: entity-oriented CRUD for projects, issues, and tasks. Use when the request is about creating/listing/updating these entities or sending a message to a task — not about launching a new coding session. See `reference/entity-commands.md` for the full surface, exit codes, and idempotency contract.

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

Use `conductor project|issue|task` when the user wants to **operate on existing entities**, not launch a new coding agent. The full surface lives in `reference/entity-commands.md`; the minimal forms to know:

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
conductor task send <id> "<message>"                   # or `--stdin` / `--from-file FILE`
conductor task messages <id> [--limit N]               # pulls a slice and exits — no --follow
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

- `CONDUCTOR_BACKEND`: default backend for `conductor fire`.
- `CONDUCTOR_PROJECT_ID`: attach `fire` to an existing project.
- `CONDUCTOR_TASK_ID`: attach `fire` to an existing task and let `send-file` auto-target that task.
- `CONDUCTOR_DAEMON_NAME`: override the daemon name without editing config.
- `CONDUCTOR_WS`: override the daemon workspace root.
- `CONDUCTOR_WS_URL`: override websocket endpoint when needed.
- `CONDUCTOR_CLI_POLL_INTERVAL_MS`: tune `fire` polling cadence.

When a child tool needs to report artifacts back into the active task, first make sure it inherits the current `CONDUCTOR_TASK_ID` or is launched from a `fire` or `daemon` flow that already provides task context. In most AI-facing cases, the next step should be `conductor send-file`.

## Boundaries

- For “transfer this conversation” requests, preserve continuity with a summary prompt; do not promise a byte-for-byte migration of hidden chat state.
- If the installed CLI and the checked-out repo differ, trust `conductor --help` and `conductor send-file --help` before giving exact flags.
- `cli/bin/conductor-chrome.js` is an auxiliary browser automation helper, not a `conductor <subcommand>` entry in the main CLI help.
- Prefer the public `conductor ...` interface in user-facing guidance instead of invoking `cli/bin/*.js` directly, unless the user is developing the CLI itself.

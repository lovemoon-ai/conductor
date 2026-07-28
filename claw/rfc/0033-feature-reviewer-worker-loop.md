# 0033 Multi-Agent Tasks (Worker + Reviewer) via Agent Docs

## Status

Accepted — MVP backend implemented (see Implementation Status)

## Owner

dang217

## Date

2026-07-28

## Summary

Let a task be created with **one or more agents**. The first agent executes the task
(the worker); any additional agents are spawned as **sibling reviewer tasks** that review
the worker. All behavior — the reviewer's cadence, what it reads, when and how it sends
feedback — lives entirely in each **registered agent's markdown doc**. Projects map
agent names to workspace-relative doc paths in `.conductor/settings.yaml`; agents carry
out those instructions through Conductor's **existing** CLI
(`conductor task messages` / `send` / `schedule create`). Conductor hard-codes **none**
of the review logic. Its only new responsibility is the one thing agents cannot do for
themselves: make the group **discoverable**. Tasks created together share a queryable
`groupId`; an agent asks **`conductor task group`** (→ `GET /tasks/:id/group`) at
runtime to find its siblings and their roles — task ids are **not** hard-passed through
the prompt. Verified: this needs no state machine, no scheduler, and no system-prompt
wiring — an idle ai_task stays `running` with its fire alive, so an agent's
self-scheduled `--every … --if-idle` wake fires reliably. (The one schema change is an
additive nullable `groupId` column + index.)

## Context

- **Problem.** A single agent on a long run can drift with no external corrective signal.
  We want domain reviewers, but we do **not** want to bake review orchestration into
  Conductor — the behavior should be authored as agent docs and run on existing
  primitives.
- **Everything the loop needs already exists (verified in code):**
  - **An idle ai_task stays `running` and its fire stays alive.** `BridgeRunner.start()`
    polls in `while (!this.stopped)` (`cli/bin/conductor-fire.js` ~2264) and only reports
    `COMPLETED`/`KILLED` after that loop breaks (shutdown/stop/error, ~1071-1102); an idle
    turn emits no terminal status. `TERMINAL_TASK_STATUSES` is only `completed`/`killed`
    (`agent-upstream.ts:166`). No idle timeout except `chat-web`. → a later scheduled
    wake (which requires `taskStatus === "running"`) will fire and be delivered.
  - **Self-scheduling is unrestricted.** `createScheduledMessageForTask`
    (`scheduled-messages.ts:279`) only checks ownership and non-pty; a task may schedule
    messages **to itself**. `CONDUCTOR_TASK_ID` is in the agent's env
    (`conductor-fire.js:1550`), so a reviewer can run
    `conductor task schedule create "$CONDUCTOR_TASK_ID" --every 1h --if-idle "…"`.
  - **Cross-task read/write already works** for same-owner tasks:
    `conductor task messages <id>` / `show <id>` (read), `conductor task send <id> "…"`
    (write, delivered as a normal user turn), authenticated by the `CONDUCTOR_AGENT_TOKEN`
    already in the agent's Bash env. Tokens are user-scoped, so this is within one owner.
  - **Client-supplied task IDs + initial context.** `POST /api/tasks` accepts a
    client `id` (`route.ts:478` → `createTaskForUser` writes it, `task-ingress-service.ts:193`),
    `initial_content` (→ `--prefill`, the first turn), and free-form `metadata`
    (JSON). `conductor task show` returns both `launch_config` and `metadata`
    (`serialization.ts:94-95`). So we can hand each task its bootstrap and stamp its group
    role in `metadata`, discoverable later via the group query.
  - **Agents read their own docs from disk.** A spawned ai_task runs in a daemon worktree
    containing the repo. `.conductor/settings.yaml` registers each agent name and its
    workspace-relative doc path; Conductor resolves the path but never parses markdown.
- **Why this is smaller than prior drafts.** Earlier drafts (a `ReviewEdge` table; a
  `ScheduledMessage` state machine; an `attachReviewer` helper; a review-policy registry)
  all put review logic in Conductor. It doesn't belong there. Moving
  it into agent docs deletes all of it. What remains is a generic "create a task with
  multiple agents and tell them about each other" — not a review feature at all.

## Goals

- Task creation accepts an ordered list of agents; the first executes the task, the rest
  are spawned as sibling reviewer tasks reviewing it.
- Reviewer behavior (cadence, reads, feedback) is authored entirely in agent markdown
  docs and executed via existing Conductor CLI — zero review logic in Conductor code.
- Conductor's only new job: pass the group's task IDs + roles to each spawned task.
- No new table, no state machine, no scheduler, no system-prompt wiring, no attach API.

## Non-Goals

- No Conductor-side review orchestration, delta extraction, verdict parsing, feedback
  routing, or Conductor-created schedules (the reviewer schedules itself).
- No `attachReviewer` helper, no first-class `Task.kind` routing, and no review policy
  encoded in `.conductor/settings.yaml` (the settings registry only maps selectable
  agent names to their docs/default backends).
- No cross-user review (tokens are user-scoped).
- (MVP) No git-diff review — reviewer reads the transcript, not the worker's worktree
  (tasks don't share a worktree). Diff access is a later follow-up.
- No new markdown parsing in Conductor — agents read their own docs.

## Options Considered

### Option A — Conductor orchestrates review (prior drafts, rejected)

`ReviewEdge` table / `ScheduledMessage` state machine / `attachReviewer` helper — all
encode review logic in the backend. Rejected: the behavior belongs in agent docs, and the
runtime already lets agents do it themselves.

### Option B — Agents-at-creation; Conductor makes the group discoverable (chosen)

Specify agents when creating a task; Conductor spawns the sibling task(s), gives them a
shared `groupId`, and exposes a `conductor task group` query so members find each other.
Everything else is in the agent docs.

- Pros: Minimal, generic Conductor surface (task-group creation + a discovery query); all
  review policy is data (markdown), versioned and per-project; supports N reviewers (N
  siblings) and any backend per agent for free; nothing review-specific is hard-coded;
  the group relationship generalizes to any same-group tasks coordinating.
- Cons: Correctness depends on agents following their docs (soft); a reviewer whose fire
  exits needs the existing restart/skip safety net; transcript-only in MVP.

**Chosen: Option B.**

## Proposed Design

### Creating a task with agents

Task creation gains an ordered `agents` list (agent names). Each name must exist in the
project's `.conductor/settings.yaml` `agents` dictionary, which supplies its
workspace-relative markdown `doc`, optional picker `description`, and optional default
`backend`. Conductor resolves and validates this registry but does **not** read the
markdown — the agent does.

- `agents: ["feature-dev"]` → run the task with the `feature-dev` agent. (Today's
  behavior, one agent.)
- `agents: ["feature-dev", "code-reviewer"]` → `feature-dev` executes the task (worker);
  `code-reviewer` is spawned as a **sibling task** that reviews the worker.
- `agents: ["feature-dev", "code-reviewer", "security-reviewer"]` → one worker, two
  reviewer siblings.

### What Conductor does — the whole of it

1. **Assign a shared `groupId`.** Mint one group id for the whole set (a new nullable
   `Task.groupId` column, indexed). Every task created together carries it, making the
   group a first-class, queryable relationship.
2. **Create the tasks.** Create the worker task with `agents[0]`; create one sibling task
   per `agents[1..]` (each an ordinary `createAndDispatchAiTask`; N agents → N creates).
   Each may carry its own `backend_type`; reviewer spawns are fail-soft.
3. **Stamp role + bootstrap.** On each task write `metadata.{groupId, agentRole,
   agentName}` (so the group query can report each member's role/agent) and an
   `initial_content` bootstrap that tells the agent *"you are agent `<name>` (role X);
   read the registered doc path and follow it"* — plus, for reviewers, *"run
   `conductor task group` to find your review target."* The worker's original prompt is
   appended after its bootstrap.
4. **Expose discovery.** `GET /api/tasks/:id/group` (CLI: `conductor task group`) returns
   every task sharing the caller's `groupId`, each with `{task_id, role, agent, status,
   is_self}`. This is how a reviewer learns the worker's id at runtime.

That is the entire Conductor contribution: assign the group, stamp each member's role,
and expose a discovery query. No schedules, no review logic, no markdown parsing. Sibling
task ids are never hard-passed through the prompt — the agent queries for them.

### What lives in the agent docs (zero Conductor code)

The reviewer's `claw/agents/code-reviewer.md` is the full operating manual, e.g.:

```markdown
---
name: code-reviewer
description: Periodically reviews the worker task for drift and regressions
---
You are a code reviewer. Find your review target by running `conductor task group`
(defaults to $CONDUCTOR_TASK_ID); the member with role "worker" is your target.

On your first turn, set up your own review cadence (do this once):
  conductor task schedule create "$CONDUCTOR_TASK_ID" --every 1h --if-idle \
    --keep-when-task-stopped \
    "Review cycle: read the worker and give feedback if needed."

Each review cycle:
  1. conductor task messages <WORKER_ID> --limit 40   # read recent progress
     conductor task show <WORKER_ID>                   # status
  2. Judge on_track | drifting | stuck. Stay silent when on track.
  3. Only if drifting/stuck, send ONE concise correction:
     conductor task send <WORKER_ID> "[review] <what to change and why>"
  4. Remember what you already advised (persistent context) — don't repeat.
```

The worker's `claw/agents/feature-dev.md` is just its domain instructions; it need not
know it is being reviewed (reviewer feedback simply arrives as user messages).

Because the reviewer self-schedules with `--if-idle` and the reviewer task stays
`running` while idle (verified), the wake fires each interval and the reviewer does its
read→judge→send in a single turn. **No state machine** — there is no async hop for
Conductor to track.

### The one problem to solve: sibling discovery — resolved

The reviewer needs the worker's id (it has its own via `CONDUCTOR_TASK_ID`). Solved by
the shared `groupId` + the `conductor task group` query: the agent asks at runtime and
gets the live group membership. This is strictly better than injecting the ids into the
prompt — it survives task restarts (new ids), costs no prompt tokens, and generalizes to
any same-group tasks discovering + messaging each other. (Historical note: an earlier
draft passed a static `metadata.linkedTasks` manifest in `initial_content`; the queryable
`groupId` supersedes it.)

### Workspace file changes — phased

- **MVP: transcript-only.** Reviewer reads `conductor task messages <W>`.
- **Later:** to let the reviewer `git diff` the worker's tree, co-locate the reviewer in
  the worker's worktree or expose a diff endpoint. Deferred; not required.

## Risks

- **Soft compliance.** Reviewer only reviews because its doc says so; quality rides on
  the doc. Mitigation: invest in the agent docs; iterate from real runs. This is by
  design — behavior is data, not code.
- **Reviewer fire exits → schedule stops.** If the reviewer's fire dies (crash/Stop/
  deploy), the task goes terminal and an `--if-idle` interval schedule completes on
  `task_not_running`. Mitigation (existing mechanisms): create the schedule with
  `stopWhenTaskNotRunning: false` (skip instead of complete while down) and rely on the
  daemon's `restart_task`/`spawnFireProcess` to respawn the fire. Confirm the CLI exposes
  a `--no-stop-when-not-running` flag; if not, that flag is the one small CLI addition.
- **Worker must be running to receive feedback.** `conductor task send` (role user) needs
  an active fire owner; fine while the worker is running (idle counts), impossible once it
  has completed (nothing to correct). Reviewer checks `task show` first.
- **Nagging / oscillation.** Mitigate via the doc ("silence when on track", one
  correction), interval floor, `--if-idle`, and the reviewer's persistent memory.
- **Same-owner only** (user-scoped tokens) — acceptable for the use case.
- **Token cost.** Persona is read from disk by the agent (cheap) rather than re-sent each
  cycle, so the recurring wake prompt can be tiny.

## Rollout

- **One additive migration**: nullable `Task.groupId` column + `@@index([groupId])`
  (`prisma db push`). No env vars, no data backfill. Flag the schema change in the PR.
- New Conductor surface is small and additive: (1) accept `agents: [...]` in the task
  create flow; (2) when >1 agent, assign a `groupId` and create sibling task(s);
  (3) stamp each member's role + bootstrap; (4) the `GET /tasks/:id/group` endpoint +
  `conductor task group` CLI. No CLI change for scheduling (`--keep-when-task-stopped`
  already exists).
- Fully backward compatible: `agents` with one entry (or omitted) behaves exactly as
  task creation does today; `groupId` is null for all existing tasks.
- Ship agent docs as ordinary repo content and register their paths under
  `.conductor/settings.yaml` `agents:`.

## Acceptance

- Creating a task with `agents: ["feature-dev", "code-reviewer"]` produces a running
  worker task and a running reviewer sibling task sharing one `groupId`;
  `conductor task group` (from either) lists both with correct roles.
- Following only its doc, the reviewer discovers the worker via `conductor task group`,
  self-schedules, and on each cycle reads the worker's progress and — when warranted —
  posts feedback via `conductor task send`, visible in the worker's transcript, with
  **no** review logic in Conductor code.
- The reviewer stays silent on a healthy cycle; it survives its own idle periods (task
  stays `running`, wake fires).
- Tests: the group endpoint returns correct members/roles/self-marker (done); the pure
  helpers validate parsing + bootstrap (done). Live loop validated by the PoC/E2E below.

## Implementation Status

MVP implementation landed and is covered by the full Web suite plus focused daemon
and SDK verification:

- **Schema** — `Task.groupId` nullable column + `@@index([groupId])` in both
  SQLite and PostgreSQL schemas, backed by
  `20260728150000_add_task_group_id`. Group creation fails with 409 on a
  pre-migration database instead of silently creating ungrouped tasks.
- **`web/src/lib/tasks/agent-group.ts`** — pure helpers: `parseAgentsInput` (validates
  the `agents` field; rejects path traversal / separators / duplicates / over-limit),
  `buildGroupMemberMetadata` (`{groupId, agentRole, agentName}`), `buildAgentBootstrap`
  (generic per-task bootstrap → points at the doc path resolved from project settings;
  reviewers are told to run `conductor task group`; worker gets its prompt appended).
  `MAX_AGENTS_PER_TASK=8`.
- **`web/src/app/api/tasks/route.ts`** — `POST /api/tasks` accepts `agents: string[]`
  (ai_task only). Assigns a shared `groupId`; `agents[0]` executes; reviewer siblings are
  spawned fail-soft via `createAndDispatchAiTask`. Response includes `reviewer_task_ids`.
  Backward compatible (no `agents` → unchanged).
- **`web/src/app/api/tasks/[taskId]/group/route.ts`** — `GET` returns
  `{group_id, members[]}` for the task's group (owner-scoped).
- **`web/src/lib/tasks/create-ai-task.ts`** — threads `groupId` onto the primary create.
- **SDK** — `BackendApiClient.getTaskGroup`, `TasksApi.getTaskGroup`,
  `TaskGroup`/`TaskGroupMember` types (`modules/conductor-sdk`).
- **CLI** — `conductor task group [id]` (defaults to `$CONDUCTOR_TASK_ID`; pretty + `--json`).
- **Per-agent backend** — the `agents` field accepts `string | { name, backend? }`. The
  worker's backend = `agents[0].backend ?? backend_type ?? registry default`; each
  reviewer = `agents[i].backend ?? registry default ?? worker's backend`. Validated in
  the parser + route + E2E.
- **Agent registry** — `.conductor/settings.yaml` owns the selectable agent dictionary
  (`name → {doc, description?, backend?}`). A dedicated lightweight
  `get_project_agents` / `project_agents_resolved` daemon protocol reads only the YAML,
  avoiding the Git snapshot work performed by project-path validation. Hosted Web
  instances use the live daemon response; old daemons and self-hosted deployments fall
  back to local reads. `GET /api/projects/:projectId/agents` exposes picker fields but
  keeps doc paths server-side. Task creation rejects unregistered names and registry
  backends the selected daemon does not advertise.
- **Frontend** — `CreateTaskDialog` gained an optional "Agents" section (ai_task only):
  registry-driven worker/reviewer selects and an "agent default / inherit /
  &lt;backend&gt;" reviewer dropdown reusing the daemon's advertised backends. Sent as
  `agents` only when a worker agent is selected (`shared/types`
  `CreateTaskInput.agents`).
- **Agent docs** — `claw/agents/code-reviewer.md` (discovers via `conductor task group`,
  self-schedules with `--if-idle --keep-when-task-stopped`, read/send cycle),
  `claw/agents/feature-dev.md`.
- **Tests** — `agent-group.test.ts`, `tasks-group-route.test.ts`,
  `CreateTaskDialog.test.tsx`, project-settings / daemon-binding / gateway / agents-route,
  task PATCH/restart, CLI group, SDK normalization, mixed-schema, and daemon registry
  coverage. The full Web and CLI suites, SDK suite/build, and production Web build pass.
- **End-to-end (real server + real SQLite, no mocks)** — against a live worktree server
  on :6153 with a seeded user/default-project and a minted JWT: `POST /api/tasks` with
  `agents:[feature-dev, {code-reviewer, backend:codex}]` created the worker + one
  reviewer sibling sharing a `groupId`; `GET /api/tasks/:id/group` (and
  `conductor task group`, pretty + JSON) returned both members with correct
  roles/agents, the reviewer's `codex` backend, and the `is_self` marker flipping by
  perspective; the worker's first message was the doc-pointing bootstrap embedding the
  user prompt, the reviewer's told it to run `conductor task group`; a plain task
  reported no group; a path-traversal agent name was rejected 400. All assertions
  passed.

Remaining (live-agent behavior, not code): a real fire-backed run where the reviewer
actually self-schedules and posts feedback over wall-clock — this needs a connected
daemon + AI backend + OTP sign-in and is the manual PoC below. The full HTTP/CLI/DB
machinery it relies on is verified above.

## Open Questions

- ~~Agent-doc location/resolution~~ **RESOLVED**: each project registers agent names,
  workspace-relative doc paths, descriptions, and optional backend defaults in
  `.conductor/settings.yaml`. The daemon couriers the sanitized registry to Web; there
  is no fixed `claw/agents/<name>.md` convention.
- Who mints IDs and issues the N creates — the frontend create flow, or a thin server
  "create task group" wrapper over `createTaskForUser`? (Either is generic, not
  review-specific.)
- ~~`--no-stop-when-not-running`~~ **RESOLVED**: the schedule CLI already exposes this as
  `--keep-when-task-stopped` (`conductor-task.js` → `stopWhenTaskNotRunning:false`),
  alongside `--every` and `--if-idle`. No CLI change needed.
- Multiple reviewers: independent feedback (N siblings) for MVP — later add aggregation
  (e.g. reviewers post to a shared scratch task) if needed?
- Should `conductor task group` be gated to same-group tasks only, or should any
  same-owner task be able to enumerate arbitrary groups? (Current: you can only query the
  group of a task you own; membership itself is unguarded within the owner.)

## Proof-of-Concept (before any code)

Prove the runtime pattern by hand, with zero code changes:

1. Create a worker task `W` (any agent) and a reviewer task `R`, each running.
2. In `R`, run `conductor task schedule create "$R" --every 10m --if-idle "read
   conductor task messages <W>; if it's drifting, conductor task send <W> '[review] …'"`.
3. Let `W` take a deliberately wrong turn; confirm `R` wakes on schedule, reads `W`, and
   posts a correction `W` then acts on; confirm `R` stays silent on a healthy cycle; and
   confirm `R` survives idle (still `running`) between wakes.
4. If it holds, the implemented create-flow change (agents list → sibling spawn + shared
   `groupId` + `conductor task group`) is all that is needed. Everything else stays in
   agent docs.

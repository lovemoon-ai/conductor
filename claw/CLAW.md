# CLAW Workspace

`claw/` is the canonical home for project memory in this repository.

Use it for durable engineering context, working design notes, execution state,
postmortems, and reusable planning templates. Do not create new root-level
`docs/` content for project memory. New material should land in `claw/`.

## Operating Model

- `claw/` is the single navigation root for humans and agents.
- Stable knowledge stays in Git, not only in local agent memory.
- Working notes can start as rough material, but once they stabilize they should
  be moved into the right folder instead of being duplicated.
- Prefer links between notes over copying the same explanation into multiple
  files.
- If a task involves `task` / `fire` / `daemon` relationships, read
  `architecture/task-fire-daemon.md` first. That document is the current source
  of truth for that subsystem.

## Folder Roles

### `architecture/`

Stable technical notes about how the monorepo fits together.

Put here:

- package maps
- runtime and lifecycle diagrams
- cross-package boundaries
- deployment topology
- long-lived data-flow notes

When a subsystem has multiple historical notes in `lessons/`, `diagnosis/`, or
`archived/`, and the model has converged, write one architecture note that
becomes the explicit source of truth for current behavior. That note should:

- state that it is the current source of truth
- link the historical notes it supersedes or consolidates
- distinguish current implementation from future or archived plans

Do not put sprint status, bug timelines, or task checklists here.

### `rfc/`

Proposals for large, cross-cutting, or workflow-shaping changes before
implementation converges.

Put here:

- multi-package design proposals
- protocol changes
- rollout plans that shape implementation direction
- workflow changes that need explicit review

When an RFC is accepted and becomes durable policy, record the lasting decision
in `adr/` and keep the RFC as history.

### `adr/`

Accepted architecture decisions.

Put here:

- final decisions that should remain easy to discover
- accepted outcomes from RFCs
- smaller architecture decisions that do not need a full RFC

ADRs are decision records, not open discussions.

### `developer/`

Contributor-facing workflow and process guidance.

Put here:

- GitHub and Linear workflow
- branch and PR conventions
- evaluation discipline
- engineering process rules that outlive a sprint

### `templates/`

Reusable document templates.

Put here:

- feature-spec templates
- implementation issue templates
- other copyable planning or documentation skeletons

Templates are reference material, not project state.

### `tasks/`

Execution queue for active project work.

Structure:

- `tasks/todo/`: planned or ready-to-execute tasks
- `tasks/done/`: completed tasks worth preserving as execution history

Task files should focus on scope, acceptance, dependencies, and next actions.

### `issues/`

Tracked product or engineering problems that still need resolution.

Put here:

- user-facing bugs
- infra issues
- execution blockers that need ownership and follow-up

If the issue is fixed and the learning matters, add a note to `lessons/`.

### `diagnosis/`

Investigation notes for incidents or failures where root cause is still being
worked out or evidence is still being collected.

Put here:

- reproduction notes
- log-based analysis
- competing hypotheses
- validation steps

Once the cause and fix are clear, summarize the durable learning in
`lessons/`, `architecture/`, or `adr/` as appropriate.

### `lessons/`

Postmortems and learned operational knowledge from real project usage.

Put here:

- bug fix retrospectives
- stability lessons
- UX mistakes and recovery notes
- recurring operational failures and how to avoid them

This folder captures "what happened, why, what changed, how to avoid it next
time".

### `product-analysis/`

External product and market comparisons.

Put here:

- competitor comparisons
- feature gap analysis
- product positioning notes
- research on adjacent tools

### `sop/`

Runbooks for repeatable operations.

Put here:

- deploy procedures
- release steps
- environment-specific operational playbooks

SOPs should be executable, ordered, and low-ambiguity.

### `archived/`

Historical material that should be preserved but is no longer the current
source of truth.

Put here:

- replaced plans
- obsolete designs
- historical references that still provide context

Archived material is never the current implementation by default. If an
archived document still matters, the current behavior should be restated in
`architecture/` or `adr/` and the archived document should only serve as
history.

Do not keep active specs here.

## Placement Rules

When adding a new note, use this order:

1. If it is a final architecture decision, use `adr/`.
2. If it is a proposed large change, use `rfc/`.
3. If it is stable technical explanation, use `architecture/`.
4. If it is active execution state, use `tasks/` or `issues/`.
5. If it is incident investigation, use `diagnosis/`.
6. If it is a completed learning from real usage, use `lessons/`.
7. If it is process guidance, use `developer/`.
8. If it is just a reusable skeleton, use `templates/`.

If several notes describe the same subsystem across time, add one current note
in `architecture/` or `adr/` that names the canonical model instead of asking
readers to reconstruct it from history.

## Naming Guidance

- Prefer descriptive file names that reveal the claim or problem directly.
- For RFCs and ADRs, the templates in `rfc/` and `adr/` are the default start
  point.
- Keep historical files on their existing names unless there is a strong reason
  to rename them.

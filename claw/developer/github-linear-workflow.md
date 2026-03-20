# GitHub + Linear Workflow

## System Of Record

- `Linear` owns roadmap, cycles, issue state, owner, priority, dependencies, and
  acceptance criteria.
- `GitHub` owns code, pull requests, review discussion, CI results, release tags,
  and long-lived engineering docs.
- Do not duplicate issue status in both systems.

Default chain:

```text
Strategy -> RFC -> ADR -> Feature Spec -> Issue -> PR -> Merge / Release -> Evaluation
```

## What Lives Where

### RFC

Use `claw/rfc/` when a change:

- spans multiple packages such as `web/`, `cli/`, and `modules/*`
- changes architecture, protocols, deployment, or team workflow
- is expected to shape the codebase for more than one sprint

### ADR

Use `claw/adr/` for accepted architecture decisions once the direction is clear.

### Feature Spec

Use a `Linear Doc` for feature-sized design. Start from
`claw/templates/feature-spec.md`.

### Implementation Issue

Use a `Linear Issue` for execution. Start from
`claw/templates/implementation-issue.md`.

### PR Notes

Keep small implementation details, screenshots, migration notes, and review
discussion in the pull request.

## Repo-Specific Rules

This repository is a monorepo with several engineering surfaces:

- `web/`: Next.js app, API routes, Prisma schema, content
- `cli/`: published `conductor` CLI
- `modules/ai-sdk/`: local AI session abstraction and provider adapters
- `modules/conductor-sdk/`: shared SDK
- `modules/volc-sms/`: SMS integration
- `scripts/`: release and ops scripts

Write an RFC before implementation if the change affects any of these:

- session lifecycle across web, CLI, and SDK
- cross-package public APIs
- deployment or database workflow
- release process for npm packages
- evaluation methodology for agent or reliability work

Write an ADR when you settle decisions such as:

- transport and reconnection model
- auth token or backend protocol shape
- package boundaries and ownership
- database dialect policy

## Linear Setup

Recommended issue types:

- `Feature`
- `Improvement`
- `Bug`
- `Design`
- `Eval`

Recommended workflow states:

- `Triage`
- `Backlog`
- `Planned`
- `In Progress`
- `In Review`
- `Blocked`
- `Done`

Hard rules:

- do not move to `In Progress` without acceptance criteria
- do not move to `In Review` without an open PR
- do not close as `Done` without merge or a documented reason

## Branch, Commit, And PR Conventions

Use the Linear issue ID in every execution artifact when work is tracked.

Examples:

- branch: `feat/ABC-123-session-retry`
- branch: `fix/ABC-456-daemon-reconnect`
- PR title: `[ABC-123] Add session retry guard`
- PR description first line: `Implements ABC-123`
- commit: `ABC-123: add session retry guard`

For tiny housekeeping work that is not tracked in Linear, keep the existing
repository style: short imperative commits such as `update ui` or
`fix volc build order`.

## PR Requirements

Every PR should include:

- the Linear issue ID
- a short summary of the problem and change
- linked RFC, ADR, or feature spec when relevant
- commands used for verification
- rollout notes for schema, env, deploy, or release impact

Add extra evidence for user-facing behavior changes:

- screenshots for UI work
- logs for infra or delivery work
- before/after evaluation for measurable AI or reliability changes

If the PR fixes a real user-facing bug, add a postmortem document in
`claw/lessons/` before merge, following the repository rule for `stable-*` or
`misc-*` bug notes.

## Evaluation Discipline

Use `Eval` issues for changes that claim improved agent quality or reliability,
for example:

- session stability
- delivery reliability
- tool call quality
- planning or navigation success rate

When measurement is feasible, attach:

- baseline
- change
- result
- report location under `eval/`

Do not claim improvement without an evaluation delta when the team can measure
it.

## Suggested Team Rituals

Every one or two days:

- clear `Triage`
- update blocked issues with blocker and next step

Weekly:

- review in-progress count and dependencies
- check whether cross-package work needs an RFC or ADR

At sprint end:

- demo from merged work
- record carry-over reasons
- capture eval regressions before planning the next cycle

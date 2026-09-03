# UI: Resume Session panel could not select the default project

- Date: 2026-09-03
- Type: ui
- Area: `web/src/features/tasks/components/ResumeSessionPanel.tsx`

## Symptom

In the CreateTaskDialog "Resume Session" mode, when a listed session had no
auto-matched project (`project_id: null`), the fallback project dropdown did
not offer the user's default project. If the daemon had no path-bound
projects, the panel dead-ended with "Bind a project on the daemon first" even
though creating a normal task against the default project works fine.

## Root cause

The panel filtered selectable projects with `project.daemonHost === host`.
The default project is host-agnostic — `isDefault: true` with no
`daemonHost` — so the filter always excluded it. The regular create form uses
a different rule (`Boolean(project.isDefault) || Boolean(project.daemonHost)`,
CreateTaskDialog line ~284) and therefore does include it; the new panel was
written against the daemon-bound-projects assumption instead of reusing the
existing selectability rule.

## Fix

Align the panel with the create form's rule:

```ts
projects.filter((p) => p.daemonHost === host || Boolean(p.isDefault))
```

Server-side semantics were verified before the change: for a project without
`daemonHost`, `POST /api/tasks` accepts the request's `agent_host` as-is
(validating only that the daemon is online and supports the backend), and on
resume `conductor fire --resume` switches to the session's original cwd, so
the default project's lack of a bound path does not matter.

## How to avoid next time

- When a new UI surface re-implements a selection list that already exists
  elsewhere (projects, daemons, backends), reuse or mirror the existing
  filter predicate instead of writing a stricter ad-hoc one; grep for the
  existing dropdown first.
- The default project is special across the codebase: no `daemonHost`, no
  workspace binding. Any `daemonHost === X` filter silently drops it — check
  `isDefault` explicitly whenever filtering projects by host.

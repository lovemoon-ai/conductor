# Resuming a linked session created a duplicate task

## Symptom

`conductor task resume --session <id>` on a session that had already been resumed into a task created a second task on the same session. The web resume panel opens the linked task instead.

## Root cause

The "one task per session" rule lived only in `ResumeSessionPanel`, which reads `linked_task_id` from `GET /api/agents/[host]/sessions`. `POST /api/tasks` passed `session_id` straight into `resumeSessionId` without checking for an existing task.

## Fix

`POST /api/tasks` now returns 409 `{ error: "session_already_linked", task_id }` when any task of the user already carries that `sessionId`. Archived tasks count too, because the check uses the same match as the sessions route. `conductor task resume` treats that 409 the way the web does, as "open the linked task": it prints the existing id (`{ id, already_linked: true }` with `--json`) and exits 0.

## How to avoid

A dedupe rule that the UI enforces by navigating elsewhere is still a product rule. Put it on the create route and let every client react to the 409.

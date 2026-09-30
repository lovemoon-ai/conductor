# PTY tasks could be archived but never restored

## Symptom

`conductor task archive <pty-task>` packed a terminal task. `unarchive` then failed with "Only ai_task can be un-packed", so the task was stuck in the archive. The web only offers Archive on AI tasks.

## Root cause

`POST /api/tasks/[taskId]/achieve` selected `taskType` but never checked it. Only the web menu hid the action.

## Fix

The achieve route now returns 409 "Only ai_task can be packed" for non-AI tasks, matching `unachieve`. The web's batch archive (select → Archive) archives only the AI tasks in the selection. It lists the terminal tasks as skipped, so one PTY task in a select-all no longer blocks the action. The button stays disabled only when every selected task is a terminal.

## How to avoid

If the reverse operation rejects a task type, the server must make the forward operation reject it too.

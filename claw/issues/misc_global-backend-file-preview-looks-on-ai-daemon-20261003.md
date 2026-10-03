# Global-backend task: file links and previews look on the AI daemon, not the workspace daemon

- Severity: P2 (new in 0.16.1; only global-backend tasks, a non-default configuration)
- Layer: routing (file preview host resolution)
- Found by: release QA 0.16.1, build `922b773`

## Reproduction
1. Project `tmp-qa1003` lives on daemon `qa-dev-daemon` (A) and contains `site/index.html` and `pic.png`.
2. `conductor task create --project tmp-qa1003 --global-backend claude@qa-dev-daemon-b --prompt 'Do not use any tools. Reply with exactly: [the site](site/index.html) and ![](pic.png)'`. This runs the AI on B, with the code on A.
3. Open the task in the web chat, then click "the site".
4. Run `conductor task preview <id> site/index.html`.

## Expected
The task card already shows A as the task's daemon, and the AI works on A's files through the remote tools. So the files named in its replies should open from A, the same way they do for an ordinary task on A.

## Observed
- The chat's popup says: "Cannot open site/index.html: no such file on qa-dev-daemon-b: site/index.html". `POST /api/tasks/<id>/preview` returns 404.
- The inline image shows "pic.png (no such file on qa-dev-daemon-b: pic.png)".
- `conductor task preview` gives `404: no such file on qa-dev-daemon-b`, for relative paths and for A's absolute paths alike.

The preview is resolved against the AI daemon (`agent_host`) and ignores the remote workspace/worktree host. This is the same split described in `claw/lessons/ui_global-backend-task-card-shows-ai-daemon-20261003.md`.

## Evidence
`claw/issues/tmp_release-qa-0161-20261003/tmp_evidence/t5_gb_link.png` (local, untracked)

## Note for the fixer
This is a user-facing bug, so add a lesson under `claw/lessons/` with the fix.

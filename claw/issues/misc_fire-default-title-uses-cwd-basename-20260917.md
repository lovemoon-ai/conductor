# misc: `conductor fire` without `--title` still names the task after the working directory, not the prompt's first clause

- Date: 2026-09-17 (QA round for the v0.13.0..278f970 release delta; feature F7 `b8a9ed6` "derive short default task titles that fit the mobile header")
- Severity: P2 (minor): the task works, and `--title` is a workaround. This is not a regression; 0.13.0 behaves the same.
- Layer: CLI (`conductor fire` task creation)

## Symptom
The commit promises that when no title is given, both the create-task dialog and `conductor fire` take the prompt's first clause (up to a comma, period or newline), capped at 10 CJK or 20 Latin characters.

The dialog does this: "Investigate the flaky websocket reconnect test in CI, then propose a fix" becomes `Investigate the`.

`conductor fire` does not. Every run named the task after the current directory's basename:

| cwd | prompt | resulting title |
|---|---|---|
| `/private/tmp/tmp_qa_e2e/a/conductor` (bound project) | `Summarize nothing, then reply with exactly QA917C13NEW` | `conductor` |
| same, CLI 0.13.0 from npm | same prompt | `conductor` |
| `…/tmp_qa_u1_proj` (bound project) | `Summarize the README briefly, then reply …` | `tmp_qa_u1_proj` |
| `…/tmp_qa_u1_nomatch` (no project) | same | `tmp_qa_u1_nomatch` |

Side effect: every fire task started from the same checkout gets the same title (`conductor`). That makes cards indistinguishable, and during QA cleanup a task was deleted by title by mistake.

## Expected
`Summarize nothing` / `Summarize the README` (first clause, ≤20 Latin characters, no split word), matching the dialog.

## Reproduction
1. `cd <any bound project checkout>`
2. `conductor fire --backend claude -- "Summarize the README briefly, then reply OK"` (no `--title`)
3. Check the task title in the web list or `GET /api/tasks/<id>`: it is the directory basename.

## Environment
Local E2E, web + dev CLI at `278f970`, daemon `qa-dev-daemon`. Compared against `@love-moon/conductor-cli@0.13.0`.

## Evidence
- `claw/issues/tmp_release-qa-20260917/tmp_evidence/c13-lead-reverify.jsonl`
- `c13-api-titles.jsonl`, `c13-fire1..4.log`
- `c13-desktop-fire-task-01df9780.png`, `c13-mobile375-header-fire-basename.png` (+ console/network logs)

## Suspected component
Default-title derivation in `cli/bin/conductor-fire.js` task creation: the cwd/project-name fallback wins over the new prompt-derived title.

## Note for the fixer
This is a user-visible product bug. Per `CLAUDE.md`, add a lesson under `claw/lessons/` with the fix.

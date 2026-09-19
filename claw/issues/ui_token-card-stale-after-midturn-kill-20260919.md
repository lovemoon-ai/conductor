# ui: token counts show `n/a` after a task is killed mid-turn, until the page is reloaded

- Date: 2026-09-19 (QA round for the v0.13.1..a6cfb20 release delta, target v0.13.2; feature `8e3a4c3`/`4dbb2d0` task and per-turn token usage)
- Severity: P2 (minor): a display-only staleness. The stored counts are correct, and a reload shows them.
- Layer: websocket / UI state (`task_token_usage` update vs. the task's `killed` status update)
- Lesson required: yes. When fixing, add a `claw/lessons/ui_*` entry per `CLAUDE.md`.

## Symptom
A claude task is killed while its first turn runs a long Bash call. The fire keeps the streamed usage and the server stores it: `GET /api/tasks/<id>` returns `token_usage_total: 20858, last_turn_token_usage: 20858`. The open page doesn't update: Runtime Details changes from `Turn Tokens …` to `Task Tokens n/a / Turn Tokens n/a` and stays that way. After a reload it shows `20.9K / 20.9K`.

| task | card while running | card 5 / 15 / 25 s after kill | after reload |
|---|---|---|---|
| `c51adbb0…` | `n/a / …` | `n/a / n/a` (10 s) | `20.9K / 20.9K` |
| `2f43ec72…` | `n/a / …` | `n/a / n/a` ×3 | `20.9K / 20.9K` |

A normal (non-killed) turn updates the card live (e.g. 20.8K → 63.8K), so this only affects the kill path.

## Expected
The card shows the kill-time usage without a reload, the same as after any other turn.

## Reproduction
1. Create a claude task with the prompt "use the Bash tool exactly once with its timeout parameter set to 300000 to run: python3 -c "import time; time.sleep(200)" …".
2. When the status shows `claude running Bash`, click the `running` pill twice (kill).
3. Keep the page open and open Runtime Details: `n/a / n/a`. `GET /api/tasks/<id>` already has the tokens. Reload: the numbers appear.

## Environment
Local dev server at `a6cfb20`, Playwright + Chrome. Evidence is in the local QA folder `claw/issues/tmp_release-qa-20260919/tmp_evidence/` (`c6-kill-midturn-card.png`, `c6-kill2-card-no-reload.png`, `c6-kill-after-reload-card.png`).

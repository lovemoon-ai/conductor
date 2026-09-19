# misc: `/compact` on a claude task is recorded as a 0-token turn

- Date: 2026-09-19 (QA round for the v0.13.1..a6cfb20 release delta, target v0.13.2; features `8c2833d` "/compact" + `8e3a4c3`/`4dbb2d0` turn token usage)
- Severity: P2 (minor): the token counter under-reports. Compaction itself and the rest of the task work.
- Layer: final state (turn-usage reporting from fire for the claude backend)
- Lesson required: yes. When fixing, add a `claw/lessons/misc_*` entry per `CLAUDE.md`.

## Symptom
After `/compact` on a claude task, the Runtime Details card shows `Turn Tokens 0`. `GET /api/tasks/<id>` returns `last_turn_token_usage: 0`, and `token_usage_total` does not change. The compaction summarised about 21K tokens of context, so it cost at least that much input.

| task | before `/compact` | confirmation | after |
|---|---|---|---|
| `f07d053b…` (daemon, tmux) | total 63,841 / last 43,002 | `claude 上下文已压缩（约 21,899 → 1,382 tokens）。` | total 63,841 / last **0** |
| `ef95f3a0…` (manual `conductor fire`) | total 41,732 / last 20,890 | `claude 上下文已压缩（约 20,910 → 1,247 tokens）。` | total 41,732 / last **0** |

## Expected
Changeset `report-turn-token-usage`: "Failed or interrupted turns and `/compact` are counted too; when a turn's usage is unknown the fire reports `null`". A compaction turn should add its real usage. If the backend does not expose it, it should report `null` (unknown), not `0`.

## Reproduction
1. Create a claude task and let it answer one turn.
2. Send `/compact`, then wait for the confirmation message.
3. Open "Service connected" → Runtime Details, or `GET /api/tasks/<id>`. Turn Tokens is `0`.

## Environment
Local dev server at `a6cfb20`, dev CLI from the same tree, claude CLI 2.1.270. Evidence is in the local QA folder `claw/issues/tmp_release-qa-20260919/tmp_evidence/` (`c5-compact-claude.png`, `m2-compact.png`, `c5-compact-claude-diagnose.json`).

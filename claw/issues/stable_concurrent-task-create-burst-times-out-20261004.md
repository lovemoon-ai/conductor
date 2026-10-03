# Bursts of ~6 concurrent task creates still time out with P1008 / P2028 (WAL on)

- Severity: P2. **Pre-existing**: it fails at the same rate on v0.16.0 (`delete` journal). The 0.16.1 WAL switch did not cause it, and it does not fix it.
- Layer: execution (server DB writes, `POST /api/tasks`)
- Found by: release QA 0.16.1 round 2, build `0714f1e` (local `main`), 2026-10-04

## Reproduction
1. Production build (`pnpm build && pnpm start`) on a snapshot of the dev DB. Daemon `qa-dev-daemon` online.
2. Fire 6 `conductor task create --project <p> --backend claude --prompt "Reply with exactly: X"` at once, then repeat every 20 s. Each burst's tasks are still starting up and writing their first messages while the next burst lands.

## Observed (5 bursts × 6 creates each, same snapshot)
| build | journal | failed creates |
|---|---|---|
| v0.16.0 | delete | 8 / 30 |
| 0714f1e | wal | 11 / 30 (9 / 30 on a second run against the live dev DB) |

Failed requests return `500` after ~6 s (sometimes ~10.5 s), and the server logs `P1008 Socket timeout` or `P2028 Transaction already closed … timeout 5000 ms` at `createAndDispatchAiTask` → `db.$transaction`. The CLI prints `Backend responded with 500`. No task is created.

## What the WAL change did fix (for contrast)
With an external reader holding a 10 s read transaction, 3 concurrent creates:
- v0.16.0 / delete: blocked ~9.2 s; 3 of 9 failed.
- 0714f1e / wal: ~0.35 s; 0 of 9 failed.

Three concurrent creates with no extra load: 15 of 15 OK in 0.47–0.66 s.

## Expected
Concurrent creates queue on the writer lock and succeed, possibly slower, instead of failing once an interactive transaction passes 5 s.

## Evidence
`claw/issues/tmp_release-qa-0161r2-20261004/` (local, untracked): `tmp_w2.sh`, `tmp_w3.sh`, `tmp_w2_*/`, and server logs `/tmp/tmp_prod_{head,head_ab,v0160}_20261004.log`.

## Note for the fixer
This is user-facing (arxiv-radar style batch creates), so add a lesson under `claw/lessons/` with the fix.

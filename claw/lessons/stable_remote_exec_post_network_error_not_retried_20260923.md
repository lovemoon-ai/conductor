# stable: `remote exec` handed `fetch failed` straight to the model (2026-09-23)

## Symptoms
- `conductor remote exec` failed with `Error: fetch failed` (exit 255) on a brief network blip. The model had to spend another round re-issuing the command; one remote-worktree session hit this 3 times.

## Root Cause
- The POST that starts a run was retried only on 429. It is not idempotent: a network error or 5xx may arrive after the daemon already spawned the command, and re-sending it would run the command twice. So every transient failure became a tool failure. Status polling already swallowed single failures; only the POST did not.

## Fix
- The CLI generates a `runId` before the first attempt and sends the same one on every retry. The exec route validates it (UUID) and passes it through. A daemon advertising `remote_exec_run_id` returns the existing run for a known id instead of spawning again, including when the duplicate arrives while the first request is still stat-ing its workspace.
- After a network error or a 5xx other than 502, the CLI asks `GET /api/agents/<host>/exec` whether the daemon dedupes. Only a clear `{ dedupesRunId: true }` enables the retry. An old server answers 405 and an old daemon answers `false`, and both keep the 429-only policy, because an old server silently drops `runId`. A 502 is the daemon's own answer (for example a bad workspace), so it is not retried. Retries also stop at the command's `--timeout`.
- Remaining risk: the daemon keeps runs in memory, so if it restarts between two attempts, the retry spawns the command again.

## Prevention
- To make a non-idempotent request retryable, give it a client-chosen idempotency key. Then confirm end to end that every hop honours the key before retrying on it: web deploys and CLI releases ship independently, so "the new CLI sends it" does not mean "the server forwards it".

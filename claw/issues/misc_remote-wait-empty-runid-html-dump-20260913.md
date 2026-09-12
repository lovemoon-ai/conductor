# misc: `conductor remote wait -t <daemon> ""` dumps the raw Next.js 404 HTML page instead of a usage error

- Date: 2026-09-13 (QA round for the v0.12.0..2970043 release delta, CLI 0.13.0 candidate)
- Severity: P2 (minor) — edge case; exit code is already 255 (CLI failure), only the output is wrong
- Layer: CLI (`conductor remote wait`, changeset `cli-remote-wait-and-retry`)

## Symptom
`./bin/conductor-dev remote wait --config-file ~/.conductor/config-dev.yaml -t qa-dev-daemon-b --timeout 5s ""` prints `Error: <!DOCTYPE html><html lang="en">…` (the whole Next 404 page, several KB) and exits 255. The empty run id is sent as `GET /api/agents/<daemon>/exec/runs/` which Next routes to the HTML not-found page.

For comparison the neighbouring cases are fine:
- missing argument → `Error: no runId given` + usage, exit 255
- bogus id → `Error: remote exec run not found: <id>`, exit 255

## Expected
Treat an empty / whitespace run id like a missing one (`Error: no runId given` + usage). Independently, non-JSON error bodies should be truncated / summarised instead of dumped verbatim.

## Reproduction
Run the command above with an empty-string positional (easy to hit from shell scripts that interpolate an unset variable, e.g. `remote wait -t B "$RUNID"`).

## Evidence
`claw/issues/tmp_release-qa-20260913/tmp_evidence/c13b-kill-and-wait-errors.log`

## Suspected component
`cli/src/remote/wait.js` argument validation + the shared error renderer in `cli/src/remote/client.js`.

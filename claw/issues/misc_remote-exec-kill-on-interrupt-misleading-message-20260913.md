# misc: `conductor remote exec --kill-on-timeout` prints "it keeps going … add --kill-on-timeout" on Ctrl-C even though the remote command was stopped

- Date: 2026-09-13 (QA round for the v0.12.0..2970043 release delta, CLI 0.13.0 candidate)
- Severity: P2 (minor) — the cancel itself works; only the message is wrong
- Layer: CLI (`conductor remote exec` / `wait`, changeset `cli-remote-wait-and-retry`)
- Surface: `./bin/conductor-dev remote exec --config-file ~/.conductor/config-dev.yaml -t qa-dev-daemon-b --timeout 60s --kill-on-timeout -- bash -lc 'sleep 20; echo X'`, then `kill -INT <cli pid>` after ~4 s

## Symptom
With `--kill-on-timeout` set, interrupting the CLI (SIGINT) usually prints:

```
[conductor] interrupted; it keeps going on qa-dev-daemon-b — resume with: conductor remote wait -t qa-dev-daemon-b <runId> (add --kill-on-timeout to stop it instead)
```

although the flag *was* passed and the remote `sleep` process is gone within ~2 s (`pgrep -f 'sleep 20.9N'` → 0). In 1 of 6 runs the CLI printed the correct line instead: `[conductor] interrupted; stopped the command on qa-dev-daemon-b`. The behavior (cancel) is consistent; the message is racy.

## Expected
Per the changeset: "exec and wait handle SIGINT/SIGTERM: the run id is printed before exiting, and with --kill-on-timeout the remote command is cancelled as well." The user-facing line must say the command was stopped (and never suggest adding a flag that is already set).

## Reproduction
1. Daemon B online (`remote_exec` capability).
2. Run the exec command above in the background; `sleep 4; kill -INT $!`.
3. Observe the message vs. `pgrep -f 'sleep 20'` — 4/4 consecutive runs printed the "keeps going" message with the process already gone.

## Evidence
- `claw/issues/tmp_release-qa-20260913/tmp_evidence/c13b-characterization.log` (4 runs, before/after process counts)
- `claw/issues/tmp_release-qa-20260913/tmp_evidence/c13-sigint.log` (the one run that printed the correct message)

## Suspected component
`cli/src/remote/exec.js` signal handler: the "stopped" vs "keeps going" branch appears to be decided before the cancel request resolves.

## Notes for the fixer
- Also print the run id in the kill branch so the user can `remote wait --json` it to confirm the terminal status.
- Bug encountered in normal product usage → per `CLAUDE.md`, write a lesson under `claw/lessons/` with the fix.

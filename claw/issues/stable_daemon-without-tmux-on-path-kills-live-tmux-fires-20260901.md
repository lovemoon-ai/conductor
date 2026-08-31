# Daemon restarted without `tmux` on PATH kills the live tmux Fires it cannot see

- Severity: P1 (major) — destroys in-flight agent work; argued for P0 below
- Layer: execution / final state (daemon startup stale sweep)
- Found: QA round 2026-09-01, build `main @ 8ad51f3` (release candidate on top of v0.11.0)
- Online issue card: `95edd6b1-1fcf-4333-986d-9ff9e1c5cab1` (conductor @ macmini, P1, todo)
- Status: **pre-existing** — reproduces identically on v0.11.0; NOT a regression introduced by 8ad51f3

## Symptom

With `fire_tmux_mode: true`, a daemon restart normally hands its detached Fires
over to the successor (this is what 8ad51f3 fixed, and it works — see the QA
report's C2). But if the successor daemon starts in an environment where `tmux`
is not on `PATH`, it logs the tmux fallback and then kills every task whose Fire
it cannot see:

```
[conductor-daemon] fire_tmux_mode is enabled but `tmux` is not available on PATH; falling back to direct spawn. ...
[conductor-daemon] Recovered 1/1 stale task(s) to killed
```

The task goes to `killed`, the Fire process dies, and the tmux session
disappears — the exact outcome the hand-off exists to prevent.

## Reproduction (100%, script at /tmp/tmp_qa_logs/repro_c4.sh)

1. Start a daemon with `fire_tmux_mode: true`.
2. Create an AI task; wait for `conductor-fire-<taskid>-*` to appear in `tmux ls`. Task is `running`.
3. `kill -TERM` the daemon. Verify the tmux session survives and the task is still `running`. ✅
4. Restart the daemon with a PATH that has node but not tmux, e.g.
   `env -i HOME=$HOME PATH=<node-bin>:/usr/bin:/bin CONDUCTOR_HOME=... node cli/bin/conductor.js daemon --config-file <cfg>`
5. Within ~10s: task status is `killed`, the Fire pid is dead, `tmux ls` reports no server.

Observed on 2026-09-01 with task `2245060e-5b11-48f5-93d7-ae793ad5655e` (fire pid 20641 → DEAD).

## Expected

`tmux` being unavailable is exactly the "I cannot see whether Fires are alive"
case, and the release's own design rule is that an inconclusive liveness answer
must never authorize a kill. 8ad51f3 already applies that rule to
`tmux list-sessions` failing and to a flaky `tmux -V` probe. A missing tmux
binary is the same class of ignorance and should likewise refuse to destroy:
skip the stale sweep for tmux-mode tasks, log loudly, and let a later
healthy-tmux start adopt them.

## Why this is realistic

The failing condition is "daemon restarted with a minimal PATH". That is the
default for launchd / systemd units, cron, and any non-login shell — on this
machine `tmux` lives in `/opt/homebrew/bin`, which such contexts routinely omit.
It also covers the window during a `brew upgrade tmux`.

## Severity argument

P1 as filed: it needs a degraded environment, and the shipped default (tmux
present) is now correct. The case for P0 is that the consequence is silent loss
of running agent work with no recovery path, which is the same damage class as
the 2026-07-23 / 07-31 / 08-31 incidents. Routing this to the human owner.

## Release impact

None relative to v0.11.0 — the no-tmux path behaves identically on both builds
(`git show v0.11.0:cli/src/daemon.js` has the same fallback and an
unconditional stale sweep). 8ad51f3 is a strict improvement: with tmux present,
Fires are now adopted instead of killed. This ticket is the remaining hole, not
a reason to hold the release.

## Fix note for whoever picks this up

Per `CLAUDE.md`, this is a `stable`-class bug: the fix must land with a lesson
under `claw/lessons/`. The natural place is the same
`tmuxFiresMayExistUnseen()` guard added in 8ad51f3 — it currently re-probes
`tmux -V`, but the startup path that decides to fall back to direct spawn runs
before it and does not feed into the sweep's kill decision.

# stable: tmux-mode Fire with a long initial prompt failed with `command too long`

- Date: 2026-09-18
- Component: `cli/src/daemon.js` `spawnFireProcess`
- Case: task `5b23df19` (persistent task, Round 3) on daemon `l20-yy`
- Diagnosis: `claw/issues/stable_task_5b23df19_daemon_inherited_root_tmux_env_restart_fail_20260918.md`

## Symptom

After the host's `TMUX` env problem was fixed, starting a new persistent round still went to `killed` right away:

```
exited with code 1: command too long
```

## Root cause

- In tmux mode the daemon runs `tmux new-session -d -e K=V … -s <name> -c <cwd> bash -c <command>`. The tmux client
  sends its whole argv to the server in a single imsg. When the argv is larger than `MAX_IMSGSIZE` (16384 bytes),
  the client prints `command too long` and exits 1 (tmux 3.2a and 3.5a both do this).
- The argv includes:
  - one `-e` flag for **every** daemon env var. On the l20-yy GPU container that was 85 vars and about 7.6KB
    (`NVIDIA_REQUIRE_CUDA` 2.2KB, `LS_COLORS` 1.5KB, …).
  - the Fire prompt, embedded in `<command>`. A persistent round prompt contains the previous rounds' summary
    (7.5KB here).
- Together they were over 16KB. The same failure hits any create_task whose first message is long (for example a
  pasted document) on a tmux-mode daemon with a large environment. Direct-spawn mode does not have this limit, which
  is why it went unnoticed.

## Fix

- Code: `spawnFireProcess` measures the tmux argv. If it is larger than `TMUX_ARGV_BYTE_BUDGET` (12KB), the daemon
  writes the shell command to `<CONDUCTOR_HOME>/daemon/fire-sessions/<session>.sh` (mode 0600) and runs
  `bash <script>` instead of `bash -c <command>`.
  - The first line of the script is `rm -f -- "$0"`, so the file (which holds the prompt) is gone as soon as bash
    opens it.
  - If the tmux client exits non-zero, no session exists, so the daemon deletes the script itself.
  - Commands under the budget use exactly the same argv as before.
- Tests: a unit test sends a ~30KB prompt and asserts: the argv is under 16KB; the argv ends in `bash <script>`;
  the script has mode 0600, deletes itself first, and contains the full prompt; the script is removed on a failed
  launch and kept on a successful one. Checked against a real tmux 3.5a: `bash -c` fails with `command too long`,
  the script form runs, bash gets all 30000 bytes, and the script deletes itself.
- Ops, until the fix ships: restarted the l20-yy daemon without `LS_COLORS`/`NVIDIA_REQUIRE_CUDA` (env flags
  7.6KB → 3.9KB). Round 4 then started and the AI replied.

## How to avoid next time

- Never pass unbounded data (prompts, user text, whole environments) as argv to a process that forwards it over a
  size-limited channel. Measure it, or pass it through a file or stdin.
- Test launches with realistic sizes: a large host env plus a long prompt, not just `"tmux hello"`.

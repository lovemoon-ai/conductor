# Symptom

- A daemon-created task expanded `${PWD}` in `pre_prompt` to the directory where `conductor daemon` was started.
- For tasks launched into a project worktree, the prompt should receive the task workspace path created for that task.

# Root Cause

- The daemon spawned `conductor-fire` with `cwd: taskDir`, but inherited `process.env.PWD` from the daemon process.
- Node's `spawn` changes the child process working directory, but it does not rewrite environment variables such as `PWD`.
- `conductor-fire` expanded `pre_prompt` environment variables from `process.env`, so `${PWD}` used the stale daemon startup value.

# Fix

- Set `PWD` in the spawned task environment to the resolved task workspace before launching `conductor-fire`.
- Added a `conductor-fire` startup guard that rewrites `PWD` from the fire process `cwd` when launched by the daemon.
- Added daemon coverage that forces a fake daemon startup `PWD` and verifies a worktree task receives the worktree workspace path instead.

# How To Avoid Next Time

- When launching child processes with a custom `cwd`, explicitly decide whether path-like environment variables should follow that `cwd`.
- Test environment-variable expansion through the daemon launch path, not only the direct CLI path.

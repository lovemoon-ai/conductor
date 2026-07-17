# Kimi Code 0.26 removed the Wire CLI contract

## Symptom

Kimi tasks stopped before their first turn. The daemon launched `kimi --wire --yolo --work-dir=...`, and Kimi Code 0.26 exited with `unknown option '--wire'`.

## Root cause

The ai-sdk treated every `kimi` executable as the legacy Python Kimi CLI. The current Kimi Code CLI has a different non-interactive contract: it runs one turn with `--prompt` and `--output-format stream-json`, uses the process working directory instead of `--work-dir`, and creates its own session ID. Passing Conductor's pre-generated UUID through `--session` would try to resume a session that Kimi Code had never created.

The current CLI also moved persisted sessions and OAuth credentials from `~/.kimi/` to `~/.kimi-code/` (or `KIMI_CODE_HOME`).

## Fix

- Probe `kimi --help` when creating a Kimi session. Keep Wire mode when `--wire` is supported; otherwise select current prompt mode when `--prompt` and `--output-format` are available.
- Run current Kimi Code turns as `kimi --prompt <text> --output-format stream-json` with `cwd` set on the child process. Do not pass Wire, print, work-dir, or approval flags.
- Remove both long and short aliases for Conductor-managed options. In particular, account for `-c` meaning continue in current Kimi Code but prompt/command in the legacy CLI, consuming its value only in legacy print mode.
- Defer the initial session announcement, consume the `session.resume_hint` JSONL record, and bind its real `session_id` for later turns and resume.
- Resolve current sessions through `~/.kimi-code/session_index.jsonl`, while preserving the legacy `~/.kimi/sessions` lookup.
- Prefer the current `~/.kimi-code/credentials/kimi-code.json` quota credential and fall back to the legacy location.

## Prevention

Treat CLI integrations as capability-based protocols rather than assuming that a shared executable name implies a stable flag set. Normalize both long options and their short aliases before composing provider-owned arguments. Regression fixtures should reject removed flags, verify the first-turn session-ID handoff, run a second resumed turn, and retain an explicit legacy-path test.

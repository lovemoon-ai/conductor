# arch: dsh task inherits stale CONDUCTOR_CLI_COMMAND from tmux server global env, sends model=opus to DeepSeek API (2026-09-17)

## Symptoms
A web-created dsh (DeepSeek Harness) task failed every turn with:

```
dsh 处理失败: dsh turn ended with reason "error": The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed opus.
```

The user's `~/.conductor/config.yaml` had no dsh entry in `allow_cli_list` and no `opus` anywhere near dsh. The daemon log even showed `CLI command: ai-sdk-managed` for the task. Yet the persisted dsh session header (`~/.conductor/dsh-sessions/<cwd>/<session>/session.jsonl`) recorded `"model":"opus"`, while all healthy dsh sessions showed `"deepseek-v4-flash"`.

## Root Cause
Two individually-reasonable behaviors composed into a cross-task environment leak:

1. **tmux server global environment is inherited by new sessions.** With `fire_tmux_mode: true`, the daemon launches Fire via `tmux new-session -d -e KEY=VALUE ...`. The `-e` flags only override the variables explicitly listed; everything else in the *tmux server's* global environment is inherited by the new session. The tmux server had been first started by an earlier claude task's spawn, so its global env contained `CONDUCTOR_CLI_COMMAND=claude --model opus` (verified with `tmux show-environment -g`). For dsh tasks the daemon sets no `CONDUCTOR_CLI_COMMAND` (`cliCommand` is empty), so the stale value leaked into the dsh Fire process.

2. **Fire blindly falls back to `CONDUCTOR_CLI_COMMAND`.** In `cli/bin/conductor-fire.js`, `resolveAiSessionCommandLine("dsh", ...)` found no `allow_cli_list` entry and fell back to `env.CONDUCTOR_CLI_COMMAND` without checking which backend that command belongs to. `extractAiSessionOptionsFromCommandLine` then parsed `--model opus` out of it, and `DshSdkSession` forwarded `model: "opus"` to the DeepSeek API → HTTP 400.

The same leak path could hit any backend without a configured `allow_cli_list` entry (dsh, copilot, external providers). `cli/src/serve-ai/index.js` had a copy of the same unguarded fallback.

## Fix
Two layers (defense in depth), plus a systemic hardening:

1. **daemon (`cli/src/daemon.js`, create_task + restart_task):** always set `CONDUCTOR_CLI_COMMAND` in the Fire spawn env — to `""` when the backend has no configured command. In tmux mode this becomes an explicit `-e CONDUCTOR_CLI_COMMAND=`, which overrides the tmux server's stale global value (verified: the pane sees an empty string). Fire's `.trim()` checks treat `""` as unset, so direct-spawn mode is unaffected.

2. **fire + serve-ai (`resolveAiSessionCommandLine` in `cli/bin/conductor-fire.js` and `cli/src/serve-ai/index.js`):** before honoring the `CONDUCTOR_CLI_COMMAND` fallback, run `inferBuiltInRuntimeBackendFromCommand` on it; if the command provably belongs to a *different* built-in backend (e.g. `claude` command for a `dsh` session), drop it. Commands whose executable is not a known backend name (custom wrappers) are still honored.

3. **systemic choke point (`spawnFireProcess` in `cli/src/daemon.js`):** a canonical `FIRE_TASK_SCOPED_ENV_KEYS` list (all task-scoped `CONDUCTOR_*` vars) is enforced at the one place that builds `tmux new-session` args: every listed key is passed explicitly — the daemon's value when set, `-e KEY=` (cleared) when absent. This kills the *pattern*, not just the instance: any future conditionally-passed task-scoped variable cannot leak from the tmux server's global env as long as it is registered in the list. Covers e.g. `CONDUCTOR_RESUME_CWD` and conditionally-set `CONDUCTOR_AGENT_TOKEN`/`CONDUCTOR_BACKEND_URL`.

Tests: `cli/test/fire.test.js` (stale/mismatched/unknown/matching command cases), `cli/test/serve-ai.test.js` (same guard), `cli/test/daemon.test.js` (env now always carries `CONDUCTOR_CLI_COMMAND`, empty when unconfigured), `cli/test/daemon-tmux-adoption.test.js` (tmux `new-session` args carry every scoped key explicitly, unset ones cleared). `cd cli && npm test` → 771 pass.

Immediate cleanup for already-polluted machines: `tmux set-environment -g -u CONDUCTOR_CLI_COMMAND` (or restart the tmux server).

## How to avoid
1. **Any environment passed to a tmux-hosted child must be treated as a merge with the server's global env, not a replacement.** Whenever a variable is security/config-relevant, pass it explicitly via `-e` on every spawn — including as an empty value — or strip it. "Absent from my env object" does NOT mean "absent in the child" under tmux.
2. **Never consume a shared, backend-agnostic channel (`CONDUCTOR_CLI_COMMAND`) without validating it matches the current backend.** Fallbacks that cross backend boundaries should sanity-check provenance (here: executable name vs. session backend).
3. When diagnosing "wrong model/config" bugs in tmux mode, check `tmux show-environment -g` first — the daemon's own logs (`CLI command: ai-sdk-managed`) only show what the daemon *intended* to pass, not what the Fire process actually inherited.

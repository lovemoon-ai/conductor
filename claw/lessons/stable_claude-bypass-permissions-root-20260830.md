# stable: claude backend unusable as root — `bypassPermissions` is refused by Claude Code

- Date: 2026-08-30
- Severity: P1 (any root-only environment: docker images, CI runners, bare VPS)
- Component: `modules/ai-sdk/src/providers/claude-agent-sdk-session.js`,
  `cli/src/daemon.js` (PTY tool-preset path), `cli/bin/conductor-config.js`

## Symptom

On a machine where conductor runs as `root`, every claude turn dies immediately and the task
never produces a reply. Claude Code exits with:

```
--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons
```

There was also no way to configure a weaker mode: the permission mode was hardcoded and no
config key or CLI flag reached it.

## The gate, verbatim

Read out of the shipped claude binary (`bin/claude.exe`), because guessing at it is how the
first version of this fix ended up half wrong:

```js
if (permissionMode === "bypassPermissions" || dangerouslySkipPermissions) {
  if (typeof process.getuid === "function" && process.getuid() === 0
      && process.env.IS_SANDBOX !== "1"
      && !Fe.CLAUDE_CODE_BUBBLEWRAP) {
    console.error("--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons");
    process.exit(1);
  }
}
```

Two different env idioms in one condition, and both matter:

- `IS_SANDBOX` is a **strict `=== "1"`** compare. `IS_SANDBOX=true` does *not* satisfy it.
- `CLAUDE_CODE_BUBBLEWRAP` goes through claude's loose truthy parser
  (`["1","true","yes","on"]`, trimmed + lowercased).

Being *more* permissive than the gate is not a safe direction: if we keep `bypassPermissions`
on `IS_SANDBOX=true`, claude just exits 1 and we are back to the original symptom with an extra
layer of indirection. `isClaudeRootPermissionRestricted()` therefore copies both idioms exactly.

(Note claude uses the *loose* parser on `IS_SANDBOX` elsewhere, for unrelated sandbox settings.
Only the root gate above governs this bug.)

## Root cause

`ClaudeAgentSdkSession.buildSdkOptions()` always resolved the permission mode through
`normalizePermissionMode()`, whose fallback is `bypassPermissions`, and additionally set
`allowDangerouslySkipPermissions: true` for that mode. `options.permissionMode` was never
populated by any caller — fire/serve-ai/daemon only pass `commandLine`, `model`, `effort` — so
in practice the mode was a constant.

Claude Code hard-refuses `bypassPermissions` / `--dangerously-skip-permissions` when
`getuid() === 0` unless `IS_SANDBOX` marks the environment as already isolated. Root installs
therefore failed on every single turn, and the default `allow_cli_list` entry
(`claude --dangerously-skip-permissions`) gave users no lever to change it.

### The second half: the PTY path

The provider session is not the only way a claude command reaches the machine. A PTY task with
`entrypoint_type: tool_preset` takes the configured `allow_cli_list` string and runs it through
a login shell (`cli/src/daemon.js`, `resolvePtyLaunchSpec`):

```js
const cliCommand = ALLOW_CLI_LIST[toolPreset];
return { command: preferredShell, args: ["-lc", cliCommand], ... };
```

That path never constructs `ClaudeAgentSdkSession`, so the permission policy above does not run
for it. With only the SDK path fixed, a root box still failed every terminal task. Worse,
`conductor config` writes `claude --dangerously-skip-permissions` into a fresh config
(`DEFAULT_CLIs`), so a new root user's very first setup step planted a flag their own machine
could not execute.

### Where a configured command string can reach the machine

Worth writing down precisely, because "it's only a log line" is the wrong mental model. The
daemon's other two `ALLOW_CLI_LIST[...]` reads (`create_task`, `restart_task`) do feed `log()`,
but they *also* export the string as `CONDUCTOR_CLI_COMMAND` into the fire child's env, and both
fire (`cli/bin/conductor-fire.js`) and serve-ai (`cli/src/serve-ai/index.js`) read it back and
pass it to `createAiSession` as `commandLine`. So the string does travel; what happens at the
far end depends entirely on the provider:

| Provider | What it does with `commandLine` |
| --- | --- |
| claude (agent-SDK) | Parses flags out of it (`--effort`, `--permission-mode`); never execs it. `resolveClaudePermissionPolicy` re-decides the mode anyway. |
| codex (`codex-exec-session.js`) | `parseCommandParts(commandLine)` → **spawns it**. |
| PTY tool_preset (daemon) | `sh -lc "<string>"` → **executes it**. |

claude is safe on the create_task/restart_task route because of the first row, not because the
string is inert. Anyone fixing an analogous flag for codex/kimi has to treat those routes as
execution paths.

## Fix

Two changes in the claude provider session:

1. **Configurable** — lift `--permission-mode <mode>` out of the configured `allow_cli_list`
   command string in the constructor, the same trick already used for `--effort`. So
   `allow_cli_list: { claude: "claude --permission-mode acceptEdits" }` now selects auto mode.
   An explicit `options.permissionMode` still wins.
2. **Auto-detected** — `resolveClaudePermissionPolicy(options, env)` downgrades
   `bypassPermissions` → `acceptEdits` (auto mode, the strongest mode claude allows as root) when
   `process.getuid() === 0` and `IS_SANDBOX` is unset, and never sets
   `allowDangerouslySkipPermissions` in that case. The downgrade is traced to the session log.
   Setting `IS_SANDBOX=1` (e.g. via config `envs:`) keeps full bypass, matching Claude Code's own
   escape hatch.

Plus the same root check applied to the two command-string sites, sharing one implementation so
the branches cannot drift:

3. `resolveClaudeCommandForRoot(commandLine, env)` (exported from ai-sdk) strips
   `--dangerously-skip-permissions` and adds/rewrites `--permission-mode acceptEdits` when the
   root check fires. `cli/src/daemon.js` calls it from `resolvePtyToolPresetCommand()` (only for
   commands that infer to the claude backend) and logs the adjustment. It is handed
   `buildPtyTaskEnv(baseEnv, env)` — byte for byte the env the spawn will give the child — so a
   per-task `IS_SANDBOX=1` in `launch_config.env` is honored, not just one in the daemon's own
   environment.
4. `cli/bin/conductor-config.js` picks the default `execArgs` through
   `isClaudeRootPermissionRestricted()`, so a config generated on a root box never contains a
   flag that box cannot run.

The whole policy is resolved once at session boot (options and env are both fixed by then) and
stored on the session, so its log lines appear at session start rather than once per turn.

An unrecognized mode (e.g. `--permission-mode auto`, which is not a claude literal) keeps the
old silent fallback to the default — a typo must never take the session down — but the session
now logs `WARN unknown permission mode "auto" in config; using ... instead (valid: ...)` so the
user finds out the config line is doing nothing.

Covered by unit tests in `modules/ai-sdk/test/claude-agent-sdk-session.test.js`
(`cd modules/ai-sdk && pnpm test`).

## How to avoid next time

- A provider default that is "the most permissive setting" is an environment-dependent choice,
  not a constant. When a backend CLI documents an environment where a flag is rejected
  (root, no-TTY, sandbox), the provider session must resolve it at boot instead of hardcoding.
- Every backend-specific knob should have a config path before it has a hardcoded default. The
  `extractLongFlagFromCommandLine(commandLine, "<flag>")` pattern in the provider constructor is
  the cheap way to expose one without new plumbing through fire/serve-ai/daemon.
- `root` is a first-class deployment target for the daemon (docker/CI/VPS). Any new
  "dangerously-*" flag we pass to a vendor CLI needs a root check before it ships.
- **A configured CLI command string reaches the machine by more than one route.** Before calling
  an allow_cli_list fix done, grep every consumer: the ai-sdk provider session (flags lifted out
  of the string), the daemon's PTY tool-preset path (string executed by a shell), and
  `conductor config` (string written into the user's file). The first version of this fix only
  covered the first route.
- **An env-reading guard must read the env of the process it is guarding.** The PTY guard first
  shipped reading the daemon's `process.env` while the child was spawned with
  `buildPtyTaskEnv(process.env, launchSpec.env)` — so a per-task escape hatch was silently
  dropped. Whenever a check decides something *about a child process*, build its env with the
  same call the spawn uses.
- **A test that only exercises the helper does not cover the wiring.** The first round of PTY
  tests passed `env` to the helper explicitly and all went green while the production call site
  passed nothing at all. Assert on the thing that actually constructs the argv
  (`buildPtyLaunchSpec`), and sanity-check the test by reverting the fix to watch it fail.
- When mirroring another program's guard, read that program's actual condition instead of
  inferring it from its error message. The error text says "root/sudo"; it does not tell you that
  `IS_SANDBOX` is a strict `"1"` compare or that `CLAUDE_CODE_BUBBLEWRAP` is a second escape
  hatch. Both were only visible in the binary.
- A tolerant fallback for bad config must still be *observable*. Silently normalizing an
  unrecognized value to the default is how a user ends up debugging "my config has no effect"
  with nothing in the logs — pair every fallback with a one-shot warning at boot.

---
"@love-moon/ai-sdk": minor
"@love-moon/conductor-cli": patch
---

Make the claude backend usable when conductor runs as root.

Claude Code refuses `bypassPermissions` / `--dangerously-skip-permissions` under
root unless `IS_SANDBOX=1` or `CLAUDE_CODE_BUBBLEWRAP` is set, so every claude
turn died immediately on root installs (docker, CI, bare VPS). Both routes a
claude command takes are now root-aware, sharing one check
(`isClaudeRootPermissionRestricted`, which mirrors claude's own gate):

- The agent-SDK session downgrades the permission mode to `acceptEdits` (auto
  mode) and stops passing `allowDangerouslySkipPermissions`.
- The daemon's tool-preset PTY path rewrites the configured `allow_cli_list`
  command via `resolveClaudeCommandForRoot`, using the same env the spawned
  child receives, so a per-task `IS_SANDBOX=1` opt-out is honored.
- `conductor config` no longer writes `--dangerously-skip-permissions` into a
  config generated on a root machine.

The mode is also configurable now: `claude --permission-mode acceptEdits` in
`allow_cli_list` is lifted out of the command string. An unrecognized mode still
falls back to the default instead of failing, but logs a warning at session boot.

ai-sdk gains three exports: `isClaudeRootPermissionRestricted`,
`resolveClaudeCommandForRoot`, `resolveClaudePermissionPolicy`.

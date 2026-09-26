---
"@love-moon/conductor-cli": minor
"@love-moon/ai-sdk": minor
---

`conductor remote mcp`: structured tools for a task whose worktree lives on
another daemon (RFC 0040).

- New `conductor remote mcp --host <daemon> --root <dir> [--cwd <dir>]`, a
  stdio MCP server with `remote_read`, `remote_edit`, `remote_write`,
  `remote_grep`, `remote_glob` and `remote_bash`, bound to that directory.
- For a `launch_config.remoteWorktree` task the daemon passes the binding to
  fire (`CONDUCTOR_REMOTE_WORKTREE`), and fire attaches the server to Claude
  (`mcpServers`) and Codex (`-c mcp_servers.*`). The agent token is forwarded
  by env only, never on argv.
- `@love-moon/ai-sdk`: the Codex app-server session accepts `configOverrides`,
  passed to the app-server as `-c key=value`.

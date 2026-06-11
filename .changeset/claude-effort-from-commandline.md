---
"@love-moon/ai-sdk": patch
---

fix: upgrade @anthropic-ai/claude-agent-sdk and honor `--effort` from `allow_cli_list` commands

The bundled `cli.js` shipped by `@anthropic-ai/claude-agent-sdk@^0.2.72` was
based on Claude Code 2.1.72, which predates the `fable` model alias. Users
configuring `claude --model fable --effort low` in their `allow_cli_list` saw
runs fail with `There's an issue with the selected model (fable). It may not
exist or you may not have access to it.` even though their system-installed
`claude` accepted the alias.

- Bump `@anthropic-ai/claude-agent-sdk` to `^0.3.173`, whose platform-specific
  binary packages ship Claude Code 2.1.173 and recognize the `fable` alias.
- `ClaudeAgentSdkSession` now lifts `--effort` out of the configured
  `commandLine` when the caller did not pass an explicit `options.effort`, so
  `claude --model fable --effort low` actually propagates the effort level to
  the SDK. Explicit `options.effort` still wins.
- Add reusable `extractLongFlagFromCommandLine` helper in `shared.js` for other
  providers that need to lift backend-specific flags out of their command
  string.

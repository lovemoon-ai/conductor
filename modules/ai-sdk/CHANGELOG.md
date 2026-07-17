# @love-moon/ai-sdk

## 0.7.4

### Patch Changes

- d5eca1c: Adapt Codex quota parsing to the 0.144 weekly-only limit while retaining compatibility with legacy header layouts and cached snapshots.
- d5eca1c: Support Kimi Code CLI prompt sessions, current session storage, and credential locations while retaining legacy Kimi wire compatibility.

## 0.7.3

### Patch Changes

- 689fd07: Accept the current Copilot SDK token option spelling in quota helpers.

## 0.7.2

## 0.7.1

## 0.7.0

## 0.6.1

### Patch Changes

- 650fc55: fix: upgrade @anthropic-ai/claude-agent-sdk and honor `--effort` from `allow_cli_list` commands

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

## 0.6.0

## 0.5.1

### Patch Changes

- 39a49fc: fix: reclaim orphaned chat-web browser and cap chat-web task lifetime

  chat-web persists one Chromium profile per provider, guarded by a per-profile
  SingletonLock. A task whose browser was not cleaned up (e.g. the ai-sdk worker
  was SIGKILLed) left an orphaned Chromium holding that lock, so the next task for
  the same provider failed to launch with `Opening in existing browser session`.

  - chat-web now reclaims stale/orphaned profile locks before launching (kills an
    orphan whose owner process is gone, clears dead locks) and refuses with a
    clear `ProfileLockedError` when a genuine live chat still holds the profile.
  - The ai-sdk worker now closes its session (and browser) on SIGTERM/SIGINT and
    bounds the close so it can't hang, preventing browser leaks on shutdown.
  - conductor fire caps a chat-web task's active lifetime (default 24h,
    `CONDUCTOR_CHATWEB_MAX_ACTIVE_MS`) and auto-stops it as
    `KILLED / max_active_duration`; chat history is preserved.

## 0.5.0

## 0.4.2

### Patch Changes

- e8936fb: Upgrade the GitHub Copilot SDK permission protocol so Copilot-backed tasks auto-approve tool calls with current Copilot CLI releases instead of failing with `unexpected user permission response`.

## 0.4.1

### Patch Changes

- aada753: Add explicit ChatGPT and Gemini web backend aliases, expose project icon
  configuration in generated CLI settings, and default browser-backed session
  checks to headed mode for reliable authenticated detection.

## 0.4.0

### Minor Changes

- 4ecc359: Publish the chat-web browser runtime and wire it into the CLI and AI SDK for
  ChatGPT and Gemini web sessions, including provider error handling and local
  development installation support.

  Ship app SDK realtime history catch-up and the CLI/AI SDK goal-mode and custom
  command runtime updates included in this release.

## 0.3.2

### Patch Changes

- 8e1d4a8: Prefer the bundled Copilot platform executable before the JS entrypoint so Node
  20 installs do not fail with `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`.

## 0.3.1

### Patch Changes

- 4e8d4e5: Include `CHANGELOG.md` in published npm tarballs.

  The `files` array in each package's `package.json` previously only
  listed the build output (`bin`/`src` for the CLI, `dist` for the
  modules). npm's `files` whitelist replaces the default include set,
  and CHANGELOG is not one of the auto-included files (only
  `package.json`, `README*`, `LICENSE*`, and `main` are unconditional).

  As a result, every release through 0.3.0 published tarballs with no
  CHANGELOG, so a consumer running `npm install` or unpacking the brew
  artifact had no way to see what changed in the version they just
  installed. The repo `cli/CHANGELOG.md` and the GitHub Release body
  remain the canonical source until 0.3.1 ships with this fix.

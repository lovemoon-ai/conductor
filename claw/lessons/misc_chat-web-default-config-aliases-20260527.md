# Chat Web backends not advertised because default config omitted aliases

## Symptom

The production `m1` daemon (CLI `0.4.0`) advertised only six backends —
`codex, claude, kimi, copilot, codex-fast, claude-fast` — even though the
runtime had `@love-moon/chat-web@0.4.0` bundled. The Web UI therefore had
nothing to render for Chat Web, and quota / restart compatibility logic
treated `web-chatgpt` and `web-gemini` as unknown.

## Root cause

Two layers were misaligned:

- The runtime intentionally requires explicit `allow_cli_list` entries for
  `chat-web`, because the backend has multiple sub-providers
  (`chatgpt` / `gemini`) selected via `--model`. The runtime code in
  `cli/src/runtime-backends.js` documents this and refuses to add `chat-web`
  to `COMMAND_OPTIONAL_BUILT_IN_RUNTIME_BACKENDS`, on the grounds that
  "the alias IS the sub-provider choice".
- The bootstrap tool `cli/bin/conductor-config.js`, however, wrote a single
  bare entry `chat-web: chat-web` when `@love-moon/chat-web` was present.
  That entry would advertise `chat-web` literally (not `web-chatgpt`
  /`web-gemini`), which is the wrong shape for both the Web UI and the
  documented user experience. In practice, users who hit this almost always
  edited the config by hand and listed the bare `chat-web` form, or did not
  add an entry at all — which is what happened on the production `m1`
  daemon.

Result: every new install was one step away from the broken state, and one
existing install had already drifted into it.

## Fix

### Operational (already applied on `m1`)

- Add `web-chatgpt: chat-web --model chatgpt` and
  `web-gemini: chat-web --model gemini` to `~/.conductor/config.yaml`.
- Restart the daemon so the new `x-conductor-backends` and
  `x-conductor-backend-runtime-map` headers are sent on reconnect. Verified
  via daemon log: starting from `2026-05-25T23:04:32` the advertised set
  includes `web-chatgpt, web-gemini`, and a task was successfully created
  against `web-chatgpt` on `2026-05-26T10:35:37`.

### Codebase (preventive)

- `cli/bin/conductor-config.js`: replace the single `chat-web` entry in
  `DEFAULT_CLIs` with two explicit aliases `web-chatgpt` and `web-gemini`,
  each carrying its own `--model` flag. Both entries declare
  `runtimeBackend: "chat-web"` so `detectInstalledCLIs()` knows to gate
  them on `isBuiltInChatWebAvailable()` rather than on a PATH binary.
- `detectInstalledCLIs()`: resolve the runtime backend through
  `info.runtimeBackend || key` before consulting `RUNTIME_SUPPORTED_BACKENDS`
  and the built-in availability checks. Without this, the new alias names
  would be rejected as "not a supported runtime backend".
- `buildConfigEntryLines()`: drop the chat-web special-case banner and add
  a short comment under `web-chatgpt` clarifying that both web-* aliases
  drive a Chromium browser via the chat-web SDK.
- `cli/test/conductor-config.test.js`: add regression assertions that the
  generated `allow_cli_list` contains both `web-chatgpt` and `web-gemini`
  with the canonical `chat-web --model …` command lines, and that the bare
  `chat-web` key is absent.

## How to avoid next time

- When a built-in backend has configurable sub-providers, never expose the
  raw runtime name in user-facing config. Generate one alias per
  recommended sub-provider in `conductor config` and document the
  sub-provider with the alias, not with a free-form comment buried in the
  YAML.
- Treat `conductor config` as the canonical contract between the runtime
  and the Web UI. If the runtime rejects a backend shape, the generator
  must never emit that shape — even with the intent that the user will fix
  it later.
- For long-lived daemons, treat config edits as requiring an explicit
  restart and surface a "running daemon was started before this config
  was last modified" hint in the Web UI's diagnostics. The daemon already
  refreshes the supported-backend log on (re)connect; making that
  refresh-on-edit explicit would have caught the M1 drift the same day.
- New built-in backends with sub-providers must add their alias names to
  the conductor-config test fixtures so future drift in the bootstrap is
  caught by CI, not by a user filing an issue.

# M1 production daemon does not advertise Chat Web aliases

## Conclusion

This is a live daemon configuration issue, not an npm installation or Web UI
filtering issue. The production `m1` daemon reads
`~/.conductor/config.yaml`, whose `allow_cli_list` does not declare
`web-chatgpt` or `web-gemini`. The CLI intentionally advertises Chat Web only
through explicitly configured aliases, so the Web app has nothing to render.

## Evidence

- Running production daemon process:
  `node .../bin/conductor daemon --force`, started at
  `2026-05-25 17:30:26 +0800`.
- Its current CLI reports `conductor version 0.4.0 (2d1526c)`.
- Global runtime package versions are all present:
  `@love-moon/conductor-cli@0.4.0`, `@love-moon/ai-sdk@0.4.0`, and
  `@love-moon/chat-web@0.4.0`.
- `~/.conductor/config.yaml` defines `daemon_name: m1` and has only:
  `codex`, `claude`, `kimi`, `copilot`, `codex-fast`, and `claude-fast`
  under `allow_cli_list`.
- The active production daemon log reports:
  `Supported Backends: codex, claude, kimi, copilot, codex-fast, claude-fast`.
- `web-chatgpt` and `web-gemini` appeared in earlier log lines from
  `/Users/duino/.conductor/config-dev.yaml`, with `Daemon Name: debug`.
  Those entries describe a development daemon, not the current production
  `m1` configuration.

## Runtime Confirmation

Evaluating `listAdvertisedBackends()` against the installed `0.4.0` runtime
and the current production config returns:

```text
codex, claude, kimi, copilot, codex-fast, claude-fast
```

Adding the two aliases in memory, without installing packages, returns:

```text
codex, claude, kimi, copilot, codex-fast, claude-fast, web-chatgpt, web-gemini
```

Both aliases resolve to the built-in runtime backend `chat-web`.

## Required Operational Fix

Add these entries to `allow_cli_list` in `~/.conductor/config.yaml`:

```yaml
  web-chatgpt: chat-web --model chatgpt
  web-gemini: chat-web --model gemini
```

Then restart the production `m1` daemon so it reconnects with updated
`x-conductor-backends` and `x-conductor-backend-runtime-map` headers.

## Status

Resolved.

### Operational fix applied

`~/.conductor/config.yaml` now contains both aliases:

```yaml
allow_cli_list:
  ...
  web-chatgpt: chat-web --model chatgpt
  web-gemini: chat-web --model gemini
```

The `m1` daemon was restarted after the edit. Verified from
`~/.conductor/logs/conductor-daemon.log`:

- First restart with the updated config at `2026-05-25T23:04:32`:
  `Supported Backends: codex, claude, kimi, copilot, web-chatgpt, web-gemini, codex-fast, claude-fast`.
- A task was created against `web-chatgpt` on `2026-05-26T10:35:37`,
  confirming end-to-end routing works through the new aliases.
- Latest restart (current daemon process, started `2026-05-27T08:26:05`)
  still advertises the same set, so the fix has survived an upgrade cycle.

### Codebase fix to prevent recurrence

The original `conductor config` bootstrap wrote a single
`chat-web: chat-web` entry, which is the wrong shape — it would
advertise the bare runtime backend name instead of a sub-provider alias.
Future fresh installs would have hit this same bug.

Updated `cli/bin/conductor-config.js` so that whenever
`@love-moon/chat-web` is bundled, the generated config contains both
canonical aliases (`web-chatgpt`, `web-gemini`) by default. Added a
regression test in `cli/test/conductor-config.test.js`.

See `claw/lessons/misc_chat-web-default-config-aliases-20260527.md` for
the full root-cause writeup.

# codex app-server config is not being honored (2026-03-19)

## Problem
When `conductor fire` uses codex app-server mode, the config values related to codex runtime behavior do not actually take effect.
Current users tend to think that the following configurations will affect `conductor fire` / `conductor fire --resume`:
- `allow_cli_list.codex`
- The parameters, for example:
- `--dangerously-bypass-approvals-and-sandbox`
  - `--ask-for-approval never`

But it won't.

## Current actual behavior
### 1. `allow_cli_list.codex` will not drive the running parameters of codex app-server
The codex path of `conductor fire` currently uses the app-server mode of ai-sdk, rather than executing it directly:
- `codex ...`
- `codex resume ...`
What is actually implemented is:
- `codex app-server --listen stdio://`
Corresponding implementation:
- `modules/ai-sdk/src/transports/codex-app-server-transport.js`
And `resolveAiSessionCommandLine()` in `cli/bin/conductor-fire.js` is currently only effective for `opencode`, and `allow_cli_list.codex` will not be read to construct the codex app-server command.
### 2. Approval and sandbox behavior is hardcoded
Relevant implementation:
- `modules/ai-sdk/src/providers/codex-app-server-session.js`
The currently fixed thread startup/resume parameters passed to app-server are:
- `approvalPolicy: "never"`
- `sandbox: "danger-full-access"`
- `personality: "pragmatic"`
- `ephemeral: false`

Therefore:
- `--ask-for-approval never`
- `--dangerously-bypass-approvals-and-sandbox`
These CLI semantics that users are familiar with are not mapped from config in app-server mode, but are hard-coded.

## Influence
- Users will mistakenly think that the codex parameter in config has taken effect
- The actual behavior of `conductor fire --resume` is inconsistent with config expectations
- approval / sandbox policy is not configurable
- There is a problem in the configuration that "it looks configurable, but actually does not take effect"

## Desired behavior
Make the key operating strategies in codex app-server mode truly configurable, including at least:
- approval policy
- sandbox mode
Requirements:
- fresh `conductor fire` sessions honor the config
- resumed `conductor fire --resume` sessions also honor the config
- behavior is consistent with configuration

## Suggestions
Two options:
### Fix A: Add app-server dedicated config
For example:
```yaml
codex_app_server:
  approval_policy: never
  sandbox: danger-full-access
```

Benefits:
- Clear semantics
- No more confusion between normal codex CLI and codex app-server
### Option B: Explicitly map existing codex configuration to app-server parameters
Convert the codex behavior configuration expressed by the user in config into app-server RPC parameters, for example:
- `approvalPolicy`
- `sandbox`

Benefits:
- More compatible for users

Drawback:
- CLI flag semantics and app-server parameter semantics are not completely equivalent and will continue to be confused in the long run.

## Recommended acceptance criteria
- The approval / sandbox of codex app-server can be controlled through config
- fresh session takes effect
- resume session takes effect
- Corresponding test coverage:
- `conductor fire`
  - `conductor fire --resume`

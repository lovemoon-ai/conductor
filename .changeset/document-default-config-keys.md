---
"@love-moon/conductor-cli": patch
---

Document every supported key in the config file `conductor config` generates.

The generated `config.yaml` only ever contained six keys, so nothing told a new
user that the other fifteen existed. They are now all present as commented-out
entries carrying their default value and env-var override, grouped into
Connection / Coding CLIs / Environment / Daemon behaviour / Optional features:

- `websocket_url`, previously written only when device authorization returned one
- `pre_prompt`, `custom_commands`, `cdp_user_data_dir`
- `remote_exec`, `fire_tmux_mode`, `auto_update`, `auto_update_respawn`,
  `update_window`
- `ai_manager.codex.auth_json`, `serve_ai.{host,port,backend,api_key}`,
  `channels.feishu.*`
- `envs.no_proxy`, `envs.DEEPSEEK_API_KEY`, `envs.DEEPSEEK_BASE_URL` alongside
  the proxy keys and `AISDK_PROVIDER_PATH` that were already shown

Three notes correct documentation that would otherwise mislead. The commented
`websocket_url` example is derived from this install's own `backend_url` (via
the same rule as `ConductorConfig.resolvedWebsocketUrl`) instead of naming the
official host, so a self-hosted user who uncomments it is not pointed at
someone else's server. `daemon_name` is flagged as the one key whose precedence
is inverted — the config value wins over `CONDUCTOR_DAEMON_NAME`. `log_level`
is marked as validated on load but not yet consumed by any component.

Behaviour is unchanged: the same six keys are still written uncommented, and
the daemon still derives its own WebSocket URL from `backend_url` regardless of
the `websocket_url` key.

# misc: codex resume Models refresh failed due to misconfiguration of VPN proxy port (2026-03-19)

## Symptoms
When the user executes `conductor fire --backend codex --resume 019d01fd-9389-7901-9588-f6d77a105847`, the codex app-server starts and reports an error:
```
[codex-app-server] stderr ERROR codex_core::models_manager::manager: failed to refresh available models: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/models?client_version=0.114.0)
```

The user mistakenly thought that the session resume failed ("not found"), but in fact the thread ready log was output normally.

## Root Cause
1. **codex app-server has two independent network paths:**- Model inference request: use `base_url = "https://rawchat.cn/codex"` configured in `~/.codex/config.toml`
- Models list refresh: hard-coded request `https://chatgpt.com/backend-api/codex/models`, do not go `base_url`
2. **VPN proxy port configuration error:**- `~/.conductor/config.yaml` and `http_proxy=http://127.0.0.1:52244` configured in shell environment- However, the actual VPN proxy port is not 52244, causing codex to fail to connect to `chatgpt.com` through the proxy.
- The error appears as "stream disconnected before completion" (the TLS handshake phase is disconnected after the proxy tunnel is established)
3. **Does not affect reasoning but affects initialization:**- Failure to refresh models is a WARNING and does not block session resume- `thread ready` is output normally in the log, and the session can actually work.
- But the user misjudged it as a failure after seeing the ERROR log.

## solve
After correcting the VPN proxy port to the actual port, the codex app-server can access `chatgpt.com` through the proxy normally, and the models refresh no longer reports an error.

## How to avoid
1. **Confirm that the proxy port is consistent with the actual VPN port:** After modifying the proxy configuration, use `curl -x <proxy> https://chatgpt.com/` to verify connectivity2. **Distinguish between two types of network requests:** `base_url` in codex only affects model inference, models refresh always goes through `chatgpt.com`, and requires a proxy or network reachability3. **Correct interpretation of log level:** `thread ready` means resume is successful. ERROR in stderr can be ignored if it does not affect the main process.
# Runbook: 将 Conductor 主部署迁移到 conductor.conductor-ai.top

把 Conductor 从根域 `conductor-ai.top` 迁移到子域 `conductor.conductor-ai.top`，
最终目标是根域不再承载 Conductor 应用。

**过渡策略（已选定）**：双域并存。先把新子域上线，apex 暂时继续跑旧服务，逐步
迁移存量客户端后再下线 apex。**本阶段不硬切，不删 apex。**

## 0. 为什么 SSO 影响可控

Conductor 的登录态**不依赖任何跨子域共享 Cookie**：

- 主登录态是 localStorage 里的 Bearer JWT（`conductor.jwt`，见 `web/src/shared/api/client.ts`
  与 `web/src/lib/auth/token-storage.ts`），按 origin 隔离。
- 唯一的 Cookie `conductor_attachment_jwt` 是 host-only（无 `Domain=`）、
  `Path=/api/tasks`、`SameSite=Strict`，仅用于附件下载。
- 接入应用走标准 OAuth 授权码流，各自持有自己的会话，不与 Conductor 共享 Cookie。

因此迁移到子域不会破坏任何 Cookie 作用域机制。要做的只是「改配置 + 迁移存量客户端」。

## 1. 代码改动（已完成）

| 文件 | 改动 |
|---|---|
| `cli/bin/conductor-config.js` | CLI 默认 backend 由 `conductor-ai.top` → `conductor.conductor-ai.top`（仅在未设 `CONDUCTOR_BACKEND_URL`/`BACKEND_URL` 时生效，影响新安装） |
| `web/src/app/HomePageClient.tsx` | 首页展示的安装命令 `curl ... /install.sh` 指向子域 |
| `cli/Formula/conductor.rb.template` | Homebrew formula homepage 指向子域 |
| `web/.env.example` | 新增 `CONDUCTOR_PUBLIC_BASE_URL` / `PUBLIC_AGENT_WS_URL` / `NEXT_PUBLIC_APP_WS_URL` / `CONDUCTOR_SSO_CLIENTS_JSON` 文档 |

> CLI 默认域改成子域是「前向正确」的：双域并存期 apex 仍在跑，新装机直接指向新域即可。

## 2. 新子域部署：服务端 env

在 `conductor.conductor-ai.top` 这套部署的 `.env`（或部署平台 env）里设置：

```
CONDUCTOR_PUBLIC_BASE_URL=https://conductor.conductor-ai.top   # token 接口返回给下游应用的 conductor_base_url；device /activate；CLI backend_url
NEXT_PUBLIC_URL=https://conductor.conductor-ai.top             # 绝对 URL / 回调 / 邮件链接（覆盖 PUBLIC_BACKEND_URL/BACKEND_URL 解析链）
# 仅当 WS 走独立 host 才需显式设置；否则会从 backend host 推导为 wss://<host>/ws/agent
# PUBLIC_AGENT_WS_URL=wss://conductor.conductor-ai.top/ws/agent
# NEXT_PUBLIC_APP_WS_URL=wss://conductor.conductor-ai.top/ws/app
```

涉及的解析逻辑：`web/src/lib/auth/config-utils.ts`（`resolvePublicBackendUrl` /
`resolveAgentWebsocketUrl`）、`web/src/app/api/oauth/token/route.ts`（`publicBaseUrl`）、
`web/src/app/api/auth/device/start/route.ts`（`verification_uri`）。

> **数据库**：复用同一套 DB（用户、session、`sso_authorization_codes`、`UserToken`），
> 否则用户与已签发的 connected-app token 不会带过去。建议新子域部署直接连现有库。

## 3. DNS + TLS

1. Volc DNS 控制台为 `conductor.conductor-ai.top` 加 A 记录（指向同一台 Volc 机器）：
   https://console.volcengine.com/TrafficRoute/dns/publiczone/zones/196217
2. nginx 增加 `server_name conductor.conductor-ai.top;` 的反代到本地端口。
3. `certbot` 为子域签证书。
4. apex 的 nginx / DNS **保持不动**（本阶段双域并存）。

> Conductor DNS 是 GeoDNS：直接查权威 NS 可能返回空，但公共解析器
> （`223.5.5.5` / `8.8.8.8`）已生效，Let's Encrypt 也通过公共解析器校验——以公共解析器为准。

## 4. SSO 接入应用（client side）的迁移

每个接入 Conductor SSO 的应用（mobile-reader、arxiv-radar 等）都把 provider 地址记在
`CONDUCTOR_BASE_URL`。逐个：

1. 改 env：`CONDUCTOR_BASE_URL=https://conductor.conductor-ai.top`
2. 重启应用。

**无需在 Conductor 侧改 `CONDUCTOR_SSO_CLIENTS_JSON` 的 redirect 白名单**——client 的
`redirect_uri` 是它**自己**的子域（`https://<app>.conductor-ai.top/api/auth/callback`），
不随 Conductor 域变化。唯一例外：若某个 client 当初把 redirect 配在了**根域 apex** 上，
需要更正。先核对那份 JSON。

存量已登录用户不受影响（client 会话自持）；仅新登录会路由到新域。

不开浏览器验证 token 通路（真 secret + 假 code，期望 `invalid_grant`）：

```sh
curl -s -X POST "https://conductor.conductor-ai.top/api/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"authorization_code","client_id":"<id>","client_secret":"<secret>","code":"x","redirect_uri":"https://<app>.conductor-ai.top/api/auth/callback"}'
# invalid_grant -> client_id + secret + redirect 都校验通过（仅 code 是假的）= 成功
# invalid_client -> 未注册或 secret 不匹配
```

## 5. CLI / daemon 存量迁移

- **新安装**：自动指向新域（代码默认已改 + 首页命令已改）。
- **存量 daemon**：`backend_url` 写死在本地 `~/.conductor/config*.yaml`，改服务端 env **不会**
  自动修好它们。靠 apex 双域并存继续工作；后续通知用户重新拉取 config 或手改 `backend_url`。
- **重新拉取 config**：登录后 `POST /api/auth/config` 会用新的 `CONDUCTOR_PUBLIC_BASE_URL`
  生成 `backend_url` / `websocket_url`。

## 6. 验证清单

- [ ] `https://conductor.conductor-ai.top` 可访问、证书有效
- [ ] 浏览器在新域完成一次真实登录（换 origin 后需重新登录一次，无数据影响）
- [ ] `POST /api/oauth/token` 返回的 `conductor_base_url` 为新域
- [ ] 设备登录 `verification_uri` 指向新域 `/activate`
- [ ] 至少一个接入应用改 env 后完成真实 OAuth 往返
- [ ] 新装 CLI 默认连到新域 daemon 正常握手

## 7. 后续（下线 apex，单独阶段，不在本次范围）

待存量客户端基本迁移完后再做：把 apex 改为 301 跳转到子域或直接停服。停服前需确认
没有存量 daemon / 接入应用仍打 apex（看访问日志），并把 `install.sh` 的对外入口收敛到子域。

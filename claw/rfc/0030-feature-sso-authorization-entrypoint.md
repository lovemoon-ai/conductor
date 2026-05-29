# 0030 SSO Authorization Entrypoint for Connected Apps

## Status

Proposed

## Owner

TBD

## Date

2026-05-27

## Summary

为 Conductor 增加一个受信任外部应用可用的 SSO 授权入口，让第三方应用可以把用户跳转到 Conductor 登录页，登录成功后自动带一次性授权码跳回第三方应用。

首个接入方是 `arxiv-radar`：

```text
arxiv-radar 点击登录
  -> https://conductor-ai.top/oauth/authorize?client_id=arxiv-radar&redirect_uri=...&state=...
  -> Conductor 登录或复用已登录态
  -> Conductor 生成短期 code
  -> redirect_uri?code=...&state=...
  -> arxiv-radar 后端用 code 换取 Conductor user token 和用户信息
  -> arxiv-radar 建立自己的登录态
```

这不是完整 OAuth/OIDC 平台。本 RFC 只定义第一版的授权码 SSO 能力，服务于受信任、预注册的 server-side connected apps。

## Context

当前 Conductor 的登录页 `web/src/app/(auth)/login/page.tsx` 已支持 `next` 参数，但只接受站内相对路径：

```ts
if (!nextPath.startsWith("/") || nextPath.startsWith("//")) {
  return "/";
}
```

这个限制是正确的，不能为了外部应用回跳而放开成任意绝对 URL，否则会把登录页变成 open redirect。

同时，当前 Web 登录态主要保存在浏览器 localStorage：

- `conductor.jwt`
- `conductor-auth`
- `conductor.userToken`

因此，一个 server-side `/oauth/authorize` route 不能直接从 cookie 得知用户是否已登录。授权入口需要是一个 client page：先复用现有 auth store 读 localStorage，未登录时跳到 `/login?next=<当前站内 authorize 路径>`，登录成功后再回到授权页，由授权页携带 `Authorization: Bearer <jwt>` 调用后端 API 创建授权码。

Conductor 已有可复用能力：

- 用户认证：`web/src/lib/auth/service.ts` 的 `signJwt()`、`authenticateToken()`
- 当前用户 API：`GET /api/auth/me`
- API token 签发：`POST /api/auth/tokens` 和 `issueApiToken()`
- token 鉴权：所有 API 已接受 `Authorization: Bearer <token>`

`arxiv-radar` 的需求是多用户登录，并且每个用户都能在 `arxiv-radar` 后端持有自己的 Conductor token，用于调用 Conductor App SDK/BFF。当前手工复制 token 的模式不适合这个场景。

## Goals

- 提供 Conductor 侧的外部应用授权入口，支持登录后自动回跳到预注册 `redirect_uri`。
- 保留 `/login?next=` 只能跳站内相对路径的安全约束。
- 支持 `arxiv-radar` 这类 server-side 应用用一次性 `code` 换取用户信息和 Conductor API token。
- 授权码必须短期有效、一次性可用、绑定 `client_id` 和 `redirect_uri`。
- 第一版只支持 Conductor 运维预注册的 trusted clients，不开放任意第三方自助注册。
- 不要求用户手工复制 token。

## Non-Goals

- 不实现完整 OAuth 2.1 / OpenID Connect 兼容层。
- 不支持 public clients、mobile deep link、PKCE-only flow。
- 不支持第三方应用自助注册、用户级授权范围选择、connected apps 管理页。
- 不引入细粒度 scopes。第一版返回的 token 与现有 user token 权限一致。
- 不改变现有 `/login?next=` 的安全策略。
- 不改变现有 Google/GitHub 登录流程。

## Options Considered

### Option A: 允许 `/login?next=https://external-app/...`

- Pros：实现最小。
- Cons：会引入 open redirect 风险；无法绑定 client、redirect_uri、state；无法做一次性 code 交换；第三方拿不到后端可安全保存的 Conductor token。

Conclusion: rejected.

### Option B: 外部应用让用户手工创建并粘贴 Conductor token

- Pros：复用当前 token 体系，零 Conductor 侧协议改动。
- Cons：用户体验差；不适合多用户 Web 应用；用户容易粘贴错 token；无法自动显示登录态。

Conclusion: rejected.

### Option C: 标准 OAuth/OIDC 完整实现

- Pros：长期标准化程度最高；生态兼容好。
- Cons：范围过大，需要 client registry、consent、scope、refresh token、PKCE、JWKS、id_token 等完整配套；当前需求只需要受信任应用授权码回跳。

Conclusion: rejected for v1.

### Option D: 受信任 connected app 授权码 SSO

- Pros：满足 `arxiv-radar` 需求；保留现有登录安全边界；协议足够清晰；可逐步演进到更完整 OAuth。
- Cons：需要新增 client allowlist、授权码存储模型、授权页和 token exchange API。

Conclusion: choose this option.

## Proposed Design

### 1. Client Registration

第一版使用部署配置注册受信任外部应用，不做 UI。

建议新增环境变量：

```bash
CONDUCTOR_SSO_CLIENTS_JSON='[
  {
    "client_id": "arxiv-radar",
    "display_name": "arxiv-radar",
    "client_secret_hash": "...",
    "redirect_uris": [
      "https://arxiv-radar.example.com/api/auth/callback",
      "http://localhost:3000/api/auth/callback"
    ],
    "trusted": true
  }
]'
```

规则：

- `client_id` 必须唯一。
- `redirect_uri` 必须 exact match，不允许前缀匹配。
- `client_secret` 只在 server-to-server code exchange 使用，不能暴露给浏览器。
- hosted production 初始只配置 `arxiv-radar`。
- local dev 可配置 `localhost` redirect URI。

如果后续需要 UI 管理，再把配置迁移到 `SsoClient` 表。本 RFC 不要求第一版建 client 管理页面。

### 2. Authorization Entrypoint

新增页面：

```text
GET /oauth/authorize
```

查询参数：

| 参数 | 必填 | 说明 |
|---|---:|---|
| `client_id` | yes | 预注册 client id，例如 `arxiv-radar` |
| `redirect_uri` | yes | 预注册回调地址，必须 exact match |
| `state` | yes | 外部应用生成的 CSRF/random state，Conductor 原样回传 |
| `response_type` | no | 第一版可省略或必须为 `code` |

页面行为：

1. 校验参数形状。不合法时显示错误页，不跳外部地址。
2. 初始化现有 auth store。
3. 如果没有 Conductor session：
   - 构造当前站内相对路径，例如 `/oauth/authorize?...`
   - `router.replace('/login?next=' + encodeURIComponent(currentRelativePath))`
4. 登录页完成后回到 `/oauth/authorize?...`。
5. 授权页使用当前 `jwtToken` 调用：

```text
POST /api/oauth/authorizations
Authorization: Bearer <conductor.jwt>
Content-Type: application/json

{
  "client_id": "arxiv-radar",
  "redirect_uri": "https://arxiv-radar.example.com/api/auth/callback",
  "state": "...",
  "response_type": "code"
}
```

6. API 返回 `{ redirect_uri }`，页面执行 `window.location.replace(redirect_uri)`。

第一版对 `trusted: true` clients 自动授权，不显示 consent screen。这样可以满足“Conductor 登录成功后自动跳转回 arxiv-radar 主页”的体验。

### 3. Authorization API

新增 API：

```text
POST /api/oauth/authorizations
```

职责：

- 通过 `getAuthUser(request)` 验证当前用户。
- 校验 `client_id` 存在。
- 校验 `redirect_uri` 与注册值 exact match。
- 校验 `response_type` 为 `code`。
- 生成高熵一次性 `code`。
- 只存储 code hash/salt/prefix，不明文存储 code。
- 设置 `expiresAt = now + 5 minutes`。
- 返回拼好并已 URL encode 的外部跳转地址：

```json
{
  "redirect_uri": "https://arxiv-radar.example.com/api/auth/callback?code=...&state=..."
}
```

错误响应：

- `401`：用户未登录。
- `400`：参数缺失或 `response_type` 不支持。
- `403`：client 不存在或 redirect URI 不匹配。

### 4. Authorization Code Storage

新增 Prisma model：

```prisma
model SsoAuthorizationCode {
  id          String    @id @default(cuid())
  clientId    String    @map("client_id")
  userId      String    @map("user_id")
  redirectUri String    @map("redirect_uri")
  codeHash    String    @map("code_hash")
  codeSalt    String    @map("code_salt")
  codePrefix  String    @map("code_prefix")
  expiresAt   DateTime  @map("expires_at")
  consumedAt  DateTime? @map("consumed_at")
  createdAt   DateTime  @default(now()) @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@index([clientId, codePrefix])
  @@index([userId, createdAt])
  @@map("sso_authorization_codes")
}
```

`code` 生成建议：

- `randomBytes(32).toString("base64url")`
- `codePrefix = code.slice(0, 8)`
- hash 复用 `hashSecret()`/`verifySecret()` 的 PBKDF2 逻辑，或抽出一个通用 secret hashing helper。

Code exchange 成功时必须在同一事务内设置 `consumedAt`，避免并发重复消费。

### 5. Token Exchange API

新增 API：

```text
POST /api/oauth/token
Content-Type: application/json
```

请求：

```json
{
  "grant_type": "authorization_code",
  "client_id": "arxiv-radar",
  "client_secret": "...",
  "code": "...",
  "redirect_uri": "https://arxiv-radar.example.com/api/auth/callback"
}
```

校验：

1. `grant_type` 必须为 `authorization_code`。
2. `client_id` 必须存在。
3. `client_secret` 必须匹配注册配置。
4. `redirect_uri` 必须与注册值 exact match。
5. `code` 必须存在、未过期、未消费、client/redirect_uri 匹配。
6. `code` 消费成功后，查出对应 user。

响应：

```json
{
  "access_token": "raw-conductor-user-token",
  "token_type": "Bearer",
  "user": {
    "id": "user-id",
    "email": "user@example.com",
    "phone": "+8613800138000",
    "name": null
  },
  "conductor_base_url": "https://conductor-ai.top"
}
```

`access_token` 语义：

- 第一版复用现有 `UserToken`。
- token name 使用约定：`connected-app:arxiv-radar`。
- 推荐实现为“每个 user + client_id 保持一个 active token”：如果已有未 revoked 且 `tokenValue` 可用的 connected-app token，则复用；否则签发新 token。
- 不返回 refresh token。
- token 撤销继续复用现有 token revoke 能力。

如果未来需要 scope，再扩展 `UserToken` 或新增 `ConnectedAppGrant`，不在本 RFC 范围内。

### 6. arxiv-radar Integration Contract

`arxiv-radar` 后端登录入口：

```text
GET /api/auth/login
```

行为：

1. 生成 `state`，写入 arxiv-radar 自己的 HttpOnly cookie。
2. 302 到：

```text
https://conductor-ai.top/oauth/authorize
  ?client_id=arxiv-radar
  &redirect_uri=https%3A%2F%2Farxiv-radar.example.com%2Fapi%2Fauth%2Fcallback
  &response_type=code
  &state=<state>
```

`arxiv-radar` 回调：

```text
GET /api/auth/callback?code=...&state=...
```

行为：

1. 校验本应用 HttpOnly cookie 里的 `state`。
2. 后端请求 Conductor `POST /api/oauth/token`。
3. 保存 arxiv-radar 自己的 session cookie。
4. session 内保存：
   - Conductor user id
   - display identity
   - encrypted Conductor `access_token`
5. 302 回 arxiv-radar 首页 `/`。

浏览器永远不接触 Conductor `access_token`，只拿到 arxiv-radar 自己的 session cookie。

### 7. Security Properties

- `/login?next=` 仍只允许站内相对路径。
- 外部跳转只发生在 `/oauth/authorize` 参数被校验、且 `redirect_uri` 在 client allowlist 内之后。
- `state` 由外部应用生成和校验，Conductor 只原样回传。
- `code` 短期有效且一次性消费。
- `code` 绑定 `client_id` 和 `redirect_uri`。
- `client_secret` 只在 server-to-server token exchange 使用。
- token exchange 不依赖 CORS，不需要允许浏览器跨站调用。
- 授权码明文只出现在一次跳转 URL 中，数据库只保存 hash。

### 8. Error UX

授权页应提供明确错误状态：

- app 未配置：`This app is not allowed to sign in with Conductor.`
- redirect URI 不匹配：`Invalid redirect URI.`
- 登录态失效：自动回 `/login?next=<authorize-path>`。
- 授权码创建失败：显示 retry 按钮，不跳外部地址。

`arxiv-radar` 回调失败时由 `arxiv-radar` 展示自己的登录失败状态。

## Implementation Plan

1. 新增 SSO client 配置 parser
   - 读取 `CONDUCTOR_SSO_CLIENTS_JSON`
   - 提供 `getSsoClient(clientId)`、`assertRedirectUri(client, redirectUri)`、`verifyClientSecret()`

2. 新增 DB migration
   - 添加 `sso_authorization_codes`
   - 更新 Prisma client

3. 新增授权码 service
   - `createSsoAuthorizationCode({ userId, clientId, redirectUri })`
   - `consumeSsoAuthorizationCode({ clientId, redirectUri, code })`
   - `getOrIssueConnectedAppToken(userId, clientId)`

4. 新增 API routes
   - `POST /api/oauth/authorizations`
   - `POST /api/oauth/token`

5. 新增 authorize page
   - `web/src/app/oauth/authorize/page.tsx`
   - 复用 `useAuthStore`
   - 未登录跳 `/login?next=<relative-authorize-path>`
   - 登录后调用 authorization API 并 `location.replace()`

6. 部署配置
   - production 配置 `arxiv-radar` client
   - local/dev 配置 localhost redirect URI

7. 接入验证
   - 用本地 `arxiv-radar` 跑完整 login/callback/token exchange。

## Risks

- 当前 Web 登录态在 localStorage，授权入口必须是 client page，不能做纯 server redirect。实现时如果误做成 server route，会一直认为用户未登录。
- 第一版返回 user-level token，没有 scope 隔离。受信任 client 泄漏 token 时影响等同用户 API token 泄漏。
- `CONDUCTOR_SSO_CLIENTS_JSON` 配置错误会导致生产无法登录或 redirect URI 不匹配。
- 如果复用 existing connected-app token，外部应用退出登录不会自动撤销 Conductor token；这是当前 token 模型的既有语义。

## Rollout

1. 先在 staging 配置 `arxiv-radar` localhost 和 preview redirect URI。
2. 验证未登录、已登录、错误 redirect URI、错误 client secret、重复 code exchange。
3. production 配置 `arxiv-radar` 正式域名。
4. `arxiv-radar` 切换登录按钮到 Conductor SSO。
5. 观察 `/api/oauth/token` 的 4xx/5xx、authorization code 创建/消费数量。

向后兼容：

- 不影响现有 `/login`、`/register`、Google/GitHub 登录。
- 不影响现有 token API。
- 不影响 CLI device auth。
- 未配置 `CONDUCTOR_SSO_CLIENTS_JSON` 时，SSO API 返回明确 403/500，不影响主站登录。

## Acceptance

- 点击 `arxiv-radar` 登录后能跳到 Conductor 登录页。
- 用户在 Conductor 登录成功后自动跳回 `arxiv-radar` callback，再回首页。
- `arxiv-radar` 首页能显示登录态。
- 未登录用户会经过 `/login?next=/oauth/authorize?...`，且 `next` 仍为站内相对路径。
- 非 allowlist `redirect_uri` 不会发生外部跳转。
- 授权码只能成功交换一次。
- 过期授权码、错误 client secret、错误 redirect URI 均返回失败。
- token exchange 返回的 `access_token` 可用于现有 Conductor API/App SDK。
- 测试覆盖 authorization service、token exchange route、authorize page 的关键状态。

## Open Questions

- 第一版是否需要在授权页展示一个“继续到 arxiv-radar”的确认按钮，还是对 `trusted` client 完全自动跳转？
- connected-app token 是复用一个长期 token，还是每次登录旋转并 revoke 旧 token？
- `CONDUCTOR_SSO_CLIENTS_JSON` 是否足够，还是应该直接落 DB，为后续 connected apps UI 铺路？
- 是否需要给 `UserToken` 增加 `clientId`、`scope`、`expiresAt` 字段，而不是依赖 token name 约定？

# RFC 0035 — Daemon Sharing API 契约（冻结）

这份文件是 Phase 1/2/3 并行开发的唯一接口真相源。**改这里之前先说一声**，
三个方向（backend routes / scope enforcement / CLI guest supervisor）都按它对齐。
分享的创建与撤销**只有前端入口**（Settings → 点进某台 daemon 的页面 → Sharing 卡片），
没有 CLI 子命令。Settings 一级页只是机器列表，不放共享操作。

Schema 与 migration 已落地：
- `web/prisma/schema.prisma` + `schema.postgres.prisma` 的 `model DaemonShare`
- `web/prisma/migrations/20260831090000_add_daemon_shares/`
- `UserToken.scope`（`full` | `daemon_share`）+ `UserToken.daemonShareId` 已在
  `20260830120000_add_user_token_scope` 中就位

## 状态机

```
pending --accept--> active --revoke--> revoked
   \--------------- revoke ----------------^
```

`status` 只有这三个值。`revoked` 是终态。

## 路由

所有路由的调用者鉴权走 `getActiveSubscriptionUser(request)`。

### `POST /api/daemon-shares`
Owner（A）为自己的某台 daemon 创建邀请。

```jsonc
// req
{ "daemonHost": "alice-mbp", "workspaceRoot": "~/conductor-guests/bob" }
// res 201
{ "id": "...", "inviteToken": "...", "inviteUrl": "https://.../app/daemon-share/<token>",
  "ownerDaemonHost": "alice-mbp", "status": "pending", "createdAt": "..." }
```

- `daemonHost` 必须是调用者当前在线的 daemon（`realtimeHub.getAgentsForUser(user.id)`），
  否则 409。禁止 `conductor-fire-*` host。
- 每台 daemon 的 **active + pending** share 上限 `MAX_SHARES_PER_DAEMON = 3` → 超出 409。
- `inviteToken`：32 字节 base64url。
- `inviteUrl` 用 `buildInviteUrl` 同款逻辑（优先 `NEXT_PUBLIC_BASE_URL`，
  见 `web/src/lib/collaboration/service.ts` —— 不要直接拼 `request.url`）。

### `GET /api/daemon-shares/invitations/[token]`
邀请页用。要求登录（防匿名探测）。

```jsonc
// res 200
{ "ownerLabel": "alice", "ownerDaemonHost": "alice-mbp", "status": "pending",
  "alreadyAccepted": false, "isSelf": false }
```

**只暴露 `ownerLabel`，绝不 echo email/phone** —— 与 RFC 0026 的教训一致。

### `POST /api/daemon-shares/accept/[token]`
Grantee（B）接受。

```jsonc
// res 200
{ "id": "...", "guestHost": "shared-alice-alice-mbp", "status": "active", "acceptedAt": "..." }
```

事务内完成：
1. `status` 必须是 `pending`，否则 409。
2. `granteeUserId !== ownerUserId`，否则 400（不能分享给自己）。
3. 生成 `guestHost`（见下）。
4. 铸 scoped token：`issueApiToken(granteeUserId, "daemon-share:<shareId>", "daemon_share")`，
   把返回的 `tokenId` 写进 `share.tokenId`，并把 `userToken.daemonShareId` 指回 share。
   **注意 `issueApiToken` 对非 full scope 不存明文**，所以原始 token 只有这一次机会拿到，
   必须在同一个事务/请求里落到 share 的下发路径上（见下面「token 下发」）。
5. `status = "active"`，`acceptedAt = now()`。

### `GET /api/daemon-shares/mine`
**daemon 侧调用**（owner A 的 daemon，带 A 的 full token）。返回该 owner 需要拉起的 guest 列表。

```jsonc
// res 200
{ "shares": [
  { "id": "...", "guestHost": "shared-alice-alice-mbp", "ownerDaemonHost": "alice-mbp",
    "workspaceRoot": "~/conductor-guests/bob", "status": "active",
    "granteeLabel": "bob", "agentToken": "<明文，仅此接口返回>" }
] }
```

- 用 `?daemonHost=` 过滤到某一台。
- **`agentToken` 只走这条 A 自己鉴权的通道下发**，不经过 B 的浏览器、不走带外渠道。
  因为 `issueApiToken` 对 scoped token 不存明文，accept 时必须把明文加密/暂存到
  share 行上供本接口下发——**实现者请在此处做决策并在 PR 里写明取舍**
  （最简单可行：`daemon_shares` 加一个 `agent_token` 列存明文，与 `user_tokens.tokenValue`
  今天对 full token 的做法一致；这不是加分项但与现状一致，别引入新的不一致）。

### `DELETE /api/daemon-shares/[id]`
Owner 或 grantee 均可撤销。

- `status = "revoked"`，`revokedAt = now()`。
- `revokeToken(granteeUserId, share.tokenId)` 撤销凭据。
- **清 `AgentOutbox` 中 `{ userId: granteeUserId, agentHost: guestHost }` 的 pending 行** ——
  否则这些命令会一直等一台永不回来的 daemon，最终进 DLQ。
- 断开该 guest 的活跃 WS 连接（`realtimeHub.takeOverAgentHost` / 直接 close）。

## `guestHost` 生成规则

```
shared-<ownerLabel>-<ownerDaemonHost>
```

**字符集必须落在 `[A-Za-z0-9._-]` 内**。原因：fire host 是
`conductor-fire-<sanitize(daemonName)>-<taskId>`，`sanitizeHostSegment`
（`modules/conductor-sdk/src/agent-host.ts:10`）会把区间外字符换成 `-`，
而 fire host 是 outbox 钉命令和附件 token 签名的依据。**不要用 `@`。**

- 超出字符集的部分先 sanitize。
- 若 B 名下已有同名（`@@unique([granteeUserId, guestHost])` 冲突）则追加短后缀去重。
- 不得以 `conductor-fire-` 开头。

## Scope 强制（Phase 1b）

`daemon_share` scope 的 token：

- **WS**：`setupAgentGateway` 中，若 token scope 为 `daemon_share`，则
  `x-conductor-host` 必须等于该 share 的 `guestHost`，否则 `socket.close(4003, ...)`。
  这条是硬要求：`agentHost` 完全由客户端断言，且重名时 `takeOverAgentHost` 会踢掉原连接，
  不校验就等于 A 能踢掉 B 自己笔记本的 daemon 并接管其 task。
- **HTTP**：`web/src/lib/auth/agent-request.ts` 的 `authenticateAgentRequest` 今天只要求
  `x-conductor-host` 非空、不校验归属，需加同样的绑定。
- **REST allowlist**：`getAuthUser`（`web/src/lib/auth/middleware.ts`，唯一收口）
  对 `daemon_share` scope 只放行 daemon/fire 实际会打的路由：
  `/api/agents`（精确，不含子路径）、`/api/tasks/**`、`/api/projects/**`、
  `/api/issues/**`、`/api/diagnostics/tasks/:id`、`/api/agent/**`。其余 403。
  集合路由**包含在内** —— fire 的 `resolveDefaultProjectId` 会打 `/api/projects`，
  guest 任务里的 AI 跑 `conductor issue` 会打 `/api/issues`。挡掉它们只会让
  guest 比普通 daemon 弱，换不来安全。
- **行级（真正防越权的那层）**：所有可寻址资源必须落在本 share 的 `guestHost` 上；
  body 里任何指向别的 daemon 的字段（`agent_host` / `target_daemon_host` /
  嵌套的 `daemonHost` …）一律拒绝。

## Guest daemon 启动契约（Phase 2）

config 文件 `~/.conductor/shares/<shareId>/config.yaml`：

```yaml
agent_token: <scoped token>
backend_url: <same as owner>
daemon_name: <guestHost>
workspace: <workspaceRoot>/ws
conductor_guest: true
# 刻意不写 envs: —— 共享 A 已登录的 AI 凭据正是本 feature 的出发点
# 也刻意不写 remote_exec: false —— guest 与普通 daemon 能力一致，见下
```

进程环境（**config 文件管不到这些，少一个就出事**）：

```
CONDUCTOR_HOME           = ~/.conductor-guests/<shareId>
CONDUCTOR_WS             = <workspaceRoot>/ws        # 决定 daemon.pid
CONDUCTOR_FIRE_STATE_DIR = ~/.conductor-guests/<shareId>/state
```

`--config-file` 显式传入时 daemon 会忽略继承来的 `CONDUCTOR_AGENT_TOKEN`
（`cli/src/daemon.js:831` `allowEnvConfigOverrides`），这是 guest 不会误用 A 身份的前提。

**Guest 的能力与普通 daemon 完全一致**，不做减法。

分界线不是「B 能不能在这台机器上执行代码」—— 他本来就能：AI 任务就是把任意 prompt
交给一个有 shell 的 CLI，`pty_task` 的 `custom` entrypoint 也直接收调用方给的
command/args/cwd/env。挡掉可脚本化的那扇门、留着交互式的那扇，挡不住任何人，
只会让共享 daemon 比普通 daemon 更难用。

只有两个动作仍然拒绝，因为它们改的是**机主的机器**而不是 B 的账号数据：
- `restart_daemon` 带 `target_version` → 跑全局 `npm install -g`，
  换掉 A 自己 daemon 和所有 fire 执行的二进制
- `ai_manager` 的 `switch_account` → 覆盖 `~/.codex/auth.json`，
  把 A 自己的活动账号一起换掉（`status`/`quota`/`list_accounts` 保留，B 需要看额度）

guest root 前缀校验（`validate_project_path` / `get_project_agents`，越界返回
`error_code: "outside_guest_root"`）**只在 A 显式设置了 `workspaceRoot` 时生效**。
A 没指定就不施加约束 —— 凭空发明一个机主没要求的限制，只会让 guest 无谓地更弱，
而且它从来就不是安全边界（B 的 agent 本来就有 shell）。

## `/api/agents` 增量（Phase 3 用）

给 grantee 返回的 agent 条目补两个字段，便于打徽标：

```jsonc
{ "host": "shared-alice-alice-mbp", "shared": true, "ownerLabel": "alice", ... }
```

按 `(granteeUserId, guestHost)` join `daemon_shares` 得到。自己的 daemon `shared: false`。

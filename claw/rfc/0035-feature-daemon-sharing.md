# 0035 Daemon Sharing (把 A 的算力借给 B)

## Status

Draft — 方向已定（Option C），细节讨论中

## 依赖

**RFC 0036（Conductor 多实例 / profile）是本 RFC 的前置依赖。**
「A 的机器上跑一个属于 B 的 daemon」本质上就是「一台机器跑两个互不干扰的实例」。
0036 落地后，本 RFC 里那份「`CONDUCTOR_HOME` / `CONDUCTOR_WS` / `CONDUCTOR_FIRE_STATE_DIR`
少设一个就 SIGKILL 掉 A 的 daemon」的注意事项清单整体消失。

注意方向：0036 隔离的是 **Conductor 自身的状态**；
**AI 凭据恰恰要不隔离**（guest 的 config 不写 `envs:`），因为共享 AI token 就是本 feature 的出发点。

## 核心假设已实测验证（2026-08-30）

用**已发布的 0.10.0**、同一台 macOS、同一个 OS 用户、两个账号实测（详见 RFC 0036「实测结论」）：

- 两个账号的 daemon **零改动共存**，各自 `/api/agents` 只看到自己那台。
- 两个 daemon **同名也不互踢**（hub 按 `(userId, host)` 分区，实测两条连接 id 并存）。
- 用户 B 在自己的 daemon 上建 project、跑 `claude` task **跑通**，
  用的是本机共享的 `~/.claude` 登录态。
- A 和 B **同时**跑 claude task 互不干扰。

**结论：本 RFC 的后端改动量确认为「几乎为零」**，真正的工作量在
share 授权流程（DaemonShare + scoped token）、supervisor、UI 三块。

由此放宽一条设计约束：`guestHost` **不需要全局唯一**，只要在 B 的命名空间内唯一。
`shared-` 前缀保留是为了 UX，不是正确性要求。

## Decisions Locked

- **定位**：组内把高配机器的算力分享给同事。A 与 B 是同事关系，**A 信任 B**。
- **形态**：Option C —— A 的 daemon 额外拉起一个「以 B 的身份连接」的 guest daemon 子进程。
- **共享 AI 工具的 token 就是本 feature 的出发点**，不是副作用。guest 与 A 同 OS 用户、
  同 `$HOME`，直接复用 A 已经登录好的 AI CLI 凭据（config 里刻意不写 `envs:`）。
- 由此推出：MVP **不做容器 / 独立 OS 用户隔离**。这是这个定位下的正确取舍，不是欠债。
  真正要防的不是「B 恶意」，而是「B 误伤 A」和「两个 daemon 抢同一份全局状态」。

## Owner

dang217

## Date

2026-08-30

## Summary

让用户 A 把自己机器上的 daemon 共享给用户 B，B 在自己的账号里能像用自己的 daemon
一样：看到这台 daemon、在上面建 project、建 task、用这台机器上已经登录好的 AI CLI
（claude / codex / …）。所有文件路径、worktree、git 操作都发生在 **A 的机器的文件系统**上。

核心结论：**不要在后端做「B 可以访问 A 的 daemon」的授权改造，而是让 A 的机器多挂一个
「属于 B 的 daemon 身份」**。前者要改掉全仓库几十处 ownership 校验，后者几乎不动后端路由。

## Context（已核对的现状）

- 后端所有 agent 路由的主键是 **`(userId, agentHost)` 这一对**，不是 host 单独：
  - `web/src/lib/realtime/hub.ts` `agentKey(userId, host)`、`findAgentConnectionByHost(host, userId)`、
    `sendToAgentHost(userId, agentHost, payload)`、`getAgentsForUser(userId)`。
  - RFC 0034 里也明确写了 `sendToAgentHost` 是 "routes by daemon name **within one user's connections**"。
- daemon 的身份来自 WS 握手：`web/src/lib/realtime/agent-gateway.ts` `setupAgentGateway()`
  用 `authenticateToken(token)` 拿到 user，再 `realtimeHub.register({ kind:"agent", userId: user.id, host: agentHost })`。
  host 来自 `x-conductor-host` 头，是一个**自由字符串**，服务端不做任何归属校验。
- 上行事件全部按连接的 userId 做行级校验：`web/src/lib/realtime/agent-upstream.ts` 里
  `fetchOwnedTaskRecord` / `ensureAgentOwnsTask` 一律 `where: { id: taskId, project: { userId } }`。
  → 只要 daemon 是用 B 的身份连的，B 的 task 事件天然合法；反之（A 的连接报 B 的 task）全线 404。
- `GET /api/agents` 直接返回 `realtimeHub.getAgentsForUser(user.id)`。
  → 只要 A 的机器上有一条以 B 身份注册的 agent 连接，**B 的 daemon 列表里立刻就能看到它，零后端改动**。
- Project 侧：`Project.daemonHost` 只是字符串，唯一约束是 `@@unique([userId, daemonHost, workspacePath])`，
  per-user 的。B 完全可以建一条指向「A 机器上那台 daemon」的 Project 行。
- CLI 侧：`cli/src/daemon.js` 里 `AGENT_TOKEN` / `AGENT_NAME` 是 startup 时算出来的闭包常量
  （`config.AGENT_TOKEN` → env → `fileConfig.agentToken`；`AGENT_NAME` = `daemon_name` → `CONDUCTOR_DAEMON_NAME` → `os.hostname()`），
  在文件里被引用 ~20 处，并且通过 `env.CONDUCTOR_AGENT_TOKEN` / `CONDUCTOR_DAEMON_NAME` 传给每个 fire 子进程。
- **daemon 的单实例锁是 `WORKSPACE_ROOT/daemon.pid`**（`cli/src/daemon.js`），不是全局锁。
  → 同一台机器上跑多个 workspace root 不同的 daemon，**今天就是支持的**。
- daemon / fire 实际打到后端的 REST 面很小：`/api/agents`、`/api/tasks`、`/api/tasks/:id`、
  `/api/tasks/:id/messages`、`/api/projects/:id`（外加 `/api/agent/**` 附件路由）。
- REST 鉴权只有一个收口：`web/src/lib/auth/middleware.ts` `getAuthUser()` → `authenticateToken()`。
  `UserToken` **没有 scope 字段**，任何 agent token 今天都等价于完整账号权限。
- 归属校验其实有 **4 层**，不止后端两层：
  1. `RealtimeHub.agentKey = `${userId}:${host}``
  2. `AgentOutbox.userId + agentHost`（离线命令的持久队列，按 user+host 钉死）
  3. `agent-upstream.ts` 的 `project: { userId }` 行级校验
  4. **daemon 自己也查**：`cli/src/daemon.js:5977` `getProjectLocalPath()` 里
     `if (daemonHost && daemonHost !== AGENT_NAME) return null` —— 拿到的 project
     不属于自己就拒绝交出本地路径。
  Option C 这 4 层**全部天然通过**；Option A 要把 4 层全部撬开。
- fire 进程自己也是一条 agent 连接，host 由 `modules/conductor-sdk/src/agent-host.ts`
  `buildFireHostName(env)` = `conductor-fire-<sanitize(CONDUCTOR_DAEMON_NAME)>-<sanitize(taskId)>`。
  它是 load-bearing 的：`agentOutbox.agentHost` 按它钉命令，附件传输 token 也按它签名。
- **代码里已经预留了这个 feature 的位置**：`web/src/app/api/issues/[issueId]/route.ts:405`
  有一条显式 403 `Target project must belong to the current user to start work on its daemon`，
  注释写着 "today fails with a misleading 'daemon offline' because `getAgentsForUser` is per-user,
  but the right error is 'not yours' … so the boundary stays clear even if anyone widens the
  per-user agent scope later"。本 RFC 就是那个 "widens the scope" 的动作。
- 已有的跨账号机制（RFC 0026 Project Collaboration）明确不覆盖本需求：
  "每个用户的 task 还是只在自己 daemon 上跑"。issue 进 doing 时还会特意
  `getUserProjectForCollaboration` 把 task 甩回 owner 自己的 daemon。
  本 RFC 正好补上 0026 缺的那一块：**协作里没有机器的人，也能干活**。

## Goals

- A 能把某台 daemon 共享给指定的 B（邀请 → 接受 → 可随时撤销）。
- B 在自己账号里看到这台 daemon、能建 project / task、能跑 AI，路径落在 A 的文件系统。
- B 跑的 task 归 B（task 行挂在 B 的 project 下），A 看不见 B 的会话内容（除了 A 本来就能读的本机日志）。
- 撤销是硬撤销：token 失效 + 进程停掉 + B 的列表里消失。
- 后端 ownership 校验代码**一行不改**。

## Non-Goals（MVP）

- **不**做真正的安全隔离（容器 / 独立 OS 用户）。见下面「信任模型」。
- **不**做用量计量 / 计费 / AI 额度分账。
- **不**做「一个 task 在 A、B 两台机器间迁移」。
- **不**做 daemon 共享的转授（B 不能再把它转share 给 C）。
- **不**改 fire / pty / remote-exec 的协议。

## Options Considered

### Option A — 后端做委托（delegation）：一条连接，服务端翻译身份

新增 `DaemonShare` 表，把 `sendToAgentHost(callerUserId, host)` 改成先解析
`(callerUserId, host) → (ownerUserId, realHost)`；同时把 `project: { userId }`
换成「可访问集合」。

- Pros：A 的机器只跑一个 daemon 进程、一条连接；共享对 daemon 完全透明。
- Cons（**否决理由**）：
  - 上行方向根本走不通：daemon 以 A 的身份连接，却要提交 B 的 task 事件。
    `agent-upstream.ts` 里 `fetchOwnedTaskRecord` / `ensureAgentOwnsTask` /
    `persistTaskExecutionHost` 等 ~40 处 `project: { userId }` 全部要放宽成
    "accessible"。**漏掉任意一处就是跨租户越权**，而这正是 0026 已经栽过一次的坑
    （"不要把 owner 转让当作所有人都能做的操作 —— 等于无声越权"）。
  - host 命名空间冲突：A 的 `alice-mbp` 和 B 自己的 `alice-mbp` 在
    `taskToAgent`、`agentDisconnectAt`、outbox drain 里会互相串。
  - 爆炸半径覆盖了本仓库最脆的一块（task ownership / 断线重连），
    而这类 bug 在 `claw/lessons/` 里是单独一个 `stable_` 前缀的类别。

### Option B — daemon 进程内多身份：一个进程，N 条 WS 连接

- Pros：后端改动同 Option C 一样少；资源占用最省；未来形态就该长这样。
- Cons：`cli/src/daemon.js` 是 7700 行单文件，`AGENT_TOKEN`/`AGENT_NAME`/`WORKSPACE_ROOT`
  是闭包常量，要把「identity context」穿透到 task 表、fire spawn env、log collector、
  lock 文件、project 路径解析全套。是一次高风险重构，不适合作为第一版。

### Option C — 受监督的 guest daemon 子进程（**建议 MVP 采纳**）

A 的 daemon 为每个已接受的共享，额外**监督拉起一个 `conductor daemon` 子进程**，
这个子进程用的是 **B 的 scoped token** 和一个独立的 config：

```
~/.conductor/shares/<shareId>/config.yaml
  backendUrl:  <same>
  agentToken:  <B 的 daemon-share scoped token>
  daemonName:  <guestHost>            # B 看到的名字
  workspace:   ~/conductor-guests/<granteeLabel>   # 同时也是它的 daemon.pid 所在
  remote_exec: false
```

- Pros：
  - 后端路由 / ownership / `/api/agents` / task 生命周期**完全复用现有代码路径**，零改动。
  - fire 子进程天然继承正确身份（daemon 本来就把 `CONDUCTOR_AGENT_TOKEN` /
    `CONDUCTOR_DAEMON_NAME` 注入 fire env）。
  - workspace root 不同 → `daemon.pid` 不冲突，多实例今天就能共存。
  - guest workspace root 天然给了一个「B 的活动范围」的落点。
  - 出问题只影响那个 guest 进程，A 自己的 daemon 不受牵连；kill 即撤销。
- Cons：
  - 每个共享一个常驻 node 进程（内存 / 自更新 / 日志各一份）。用 per-daemon 上限（建议 3）兜住。
  - A 的 daemon 要做一层 supervisor（拉起、退避重启、随撤销 kill、随主 daemon 退出清理）。

**结论：MVP 走 C，协议 / 数据模型 / UX 都按将来能平滑换成 B 来设计**
（supervisor 以后换成进程内多路复用，对后端和前端不可见）。

## Detailed Design（草案）

### 数据模型

```prisma
model DaemonShare {
  id              String    @id @default(uuid())
  ownerUserId     String    @map("owner_user_id")        // A
  ownerDaemonHost String    @map("owner_daemon_host")    // A 机器上真实的 daemon name
  granteeUserId   String?   @map("grantee_user_id")      // B，accept 前为 null
  guestHost       String?   @map("guest_host")           // B 侧看到的 host
  inviteToken     String    @unique @map("invite_token") // 32B base64url
  workspaceRoot   String?   @map("workspace_root")       // A 机器上给 B 的根目录
  tokenId         String?   @map("token_id")             // 给 B 铸的 scoped UserToken
  status          String    @default("pending")          // pending | active | revoked
  acceptedAt      DateTime? @map("accepted_at")
  revokedAt       DateTime? @map("revoked_at")
  createdAt       DateTime  @default(now()) @map("created_at")

  @@unique([granteeUserId, guestHost])
  @@index([ownerUserId, ownerDaemonHost])
  @@index([granteeUserId])
  @@map("daemon_shares")
}

model UserToken {
  // ...
  scope         String  @default("full")   // full | daemon_share
  daemonShareId String? @map("daemon_share_id")
}
```

`guestHost` 命名（**有硬约束**）：字符集必须落在 `[A-Za-z0-9._-]` 之内。
因为 `sanitizeHostSegment` 会把区间外的字符统统换成 `-`，而 fire host 是
`conductor-fire-<sanitize(daemonName)>-<taskId>`，一旦 guestHost 里的分隔符被抹平，
两个不同的 guest daemon 在 fire 层就可能撞名——而 fire host 又是 outbox 钉命令和附件
token 签名的依据。所以 **不要用 `@`**（第一版草稿里写错了）。
建议 `shared-<ownerLabel>-<ownerDaemonHost>`，例如 `shared-alice-alice-mbp`：
`shared-` 前缀让 B 一眼看出这不是自己的机器，也不撞 `isConductorFireHost` 的
`conductor-fire-` 前缀；accept 时若 B 名下已有同名则加短后缀去重（`@@unique([granteeUserId, guestHost])` 兜底）。

### Token scoping（**这条是安全底线，不能省**）

今天 `UserToken` 没有 scope，`authenticateToken` 返回的 token 等价于完整账号权限。
如果直接给 B 铸一个普通 token 放到 A 的磁盘上，**A 就拿到了 B 的账号**。所以：

- `AuthUser` 带上 `tokenScope`。
- `getAuthUser()`（唯一收口）对 `daemon_share` scope 只放行 allowlist：
  `/api/agents`、`/api/tasks`(POST/GET 且限定 agentHost)、`/api/tasks/:id`、
  `/api/tasks/:id/messages`、`/api/projects/:id`、`/api/agent/**`。
- 行级：这个 token 只能碰 `agentHost == guestHost` 的 task 和绑定在该 host 上的 project。

#### host 绑定是**硬要求**，不是锦上添花

`agentHost` 完全由客户端断言（`x-conductor-host` 头，服务端不校验），而且
`agent-gateway.ts:1408` 在发现重名时会 `takeOverAgentHost()` **踢掉原有连接**。
所以如果 share token 不绑死 host，**A 只要用这个 token 连上来并声称
`x-conductor-host: <B 自己笔记本的 hostname>`，就能把 B 真正的 daemon 踢下线，
并接管本该发往 B 自己机器的所有 task**。这不是权限放大的边角，是直接接管 B 的其它机器。

因此两条路径都必须校验：
- WS：`setupAgentGateway` 里，`daemon_share` token 的 `x-conductor-host` 必须
  等于 `share.guestHost`，否则 close 4003。
- HTTP：`web/src/lib/auth/agent-request.ts` `authenticateAgentRequest()` 今天只要求
  `x-conductor-host` **非空**，不校验归属，同样要加这条检查。

#### 铸 token 时的三个坑（都在既有代码里，很容易漏）

`getLatestTokenValue(userId)` = 「该 user 最新的未撤销 token」，**没有 scope 过滤**：

```ts
const latest = await db.userToken.findFirst({
  where: { userId, revokedAt: null }, orderBy: { createdAt: "desc" },
});
return latest?.tokenValue ?? null;
```

一旦给 B 铸了 share token，它就是 B 最新的 token，于是：
1. `/api/auth/tokens/latest` 和 `/api/auth/config` 会把**这个受限 token** 发给
   B 自己的新 daemon → B 自己的机器连不上/行为异常。
2. `approveDeviceAuthorization()` 复用「最新未撤销 UserToken」，B 下次跑
   `conductor config` 走设备授权，同样会拿到 share token。
3. `UserToken.tokenValue` **明文存原始 token**（和旁边的 PBKDF2 `tokenHash` 并存），
   所以 share token 会明文躺在 B 的库里 + A 的磁盘上两份。

修法：上面三处查询一律加 `scope: "full"`；share token 建行时 `tokenValue: null`。

### 前置修复（不属于本 feature，但会被它放大）

`hub.ts:574` `sendToAgent(taskId, payload)` 按 taskId 找 host 之后，调用
`findAgentConnectionByHost(host)` 时**故意不传 userId**（"任意 owner"，注释说
task-id 路由本身已经蕴含归属）。但 `taskToAgent` 存的是 host **字符串**，而
daemon 默认名就是 `os.hostname()` —— 两个不同账号的机器同叫 `MacBook-Pro.local`
是很常见的。此时命中的是 Map 迭代序里的第一条连接，**可能是另一个租户的 daemon**。

受影响的是 `app-gateway.ts` 的终端转发路径（`deliverTerminalAttachEnvelope`、
`revokePtyDirectTransport`、`terminal_input`/`terminal_resize`/`terminal_detach`
在 line 567 的转发）—— 也就是说**用户在终端里敲的原始按键可能被投递到另一个租户的机器上**。
授权本身没破（taskId 在上游已鉴权），破的是路由。

daemon 共享把「一台机器承载多个用户身份」变成常态，正好踩在这个歧义上，所以建议
先把 `sendToAgent` 改成带 userId 的重载（调用方都拿得到 `user.id`）再做本 feature。

### 流程

```
A: Web 上 Settings → Connected Daemons → 某台 daemon 点「Share」
     → POST /api/daemon-shares          → 邀请链接 /app/daemon-share/<inviteToken>
B: 打开链接（需登录）→ 接受
     → POST /api/daemon-shares/:token/accept
        · 校验 status=pending、B != A、A 的 per-daemon 共享数未超上限
        · 生成 guestHost、铸 scoped token（scope=daemon_share, daemonShareId=…）
        · status=active
A 的 daemon: 通过自己那条已鉴权的 WS 收到 daemon_share_updated 推送
     （或重连时 GET /api/daemon-shares/mine 兜底）
        · token 只走 A 自己的鉴权通道下发，不经过 B 的浏览器，不走带外渠道
        · 写 ~/.conductor/shares/<id>/config.yaml，建 guest workspace root
        · spawn 受监督的 guest daemon 子进程
B: 刷新 → GET /api/agents 里出现 alice-mbp@alice（带「共享」徽标）
        · 建 project 绑到该 host，workspace 路径必须在 guest root 之下
        · 建 task → 现有链路，一路不变
撤销: A DELETE /api/daemon-shares/:id  或  B 主动 leave
        · revoke UserToken → 断开 guest WS → kill guest 子进程 → B 侧 host 消失
        · 清掉 `AgentOutbox where userId=B and agentHost=guestHost` 的 pending 行，
          否则撤销后这些命令会一直躺在队列里等一台永远不会回来的 daemon（最终进 DLQ）
        · 在跑的 task 走现有断线语义；B 的 project 行保留但变成 orphan binding
```

### daemon 侧改动（Option C 的全部工作量）

1. ~~`conductor daemon share` 子命令组~~ —— **不做**。入口是前端，与项目分享一致：
   机主在 Settings 的 daemon 卡片上点 Share（创建 + 复制链接），受邀方打开链接接受。
   CLI 只负责 supervisor，不提供分享管理命令。
2. supervisor：读 `GET /api/daemon-shares/mine`，对每个 active share 维护一个子进程，
   带退避重启；主 daemon 退出时一并清理；`share.status != active` 时 SIGTERM。
3. guest daemon 必须 fail fast：现在 `AGENT_TOKEN` 缺失会回落到字符串
   `"default-agent-token"`（`daemon.js:850`）而不是报错，guest 模式下要直接退出。
4. guest 模式的收紧开关（沿用现有 config 机制）：
   `remote_exec: false`；workspace 路径校验必须落在 `workspaceRoot` 之下
   （`validate_project_path` 已经在 daemon 侧跑，加一个 root 前缀检查即可）；
   可选关掉 `pty_task` capability；per-share 并发 task 上限。

### Guest daemon 的进程模型

```
A 的机器（同一个 OS 用户、同一个 $HOME）
├── conductor daemon                       ← A 自己的，~/.conductor/config.yaml
│   └── supervisor
│        └── conductor daemon --config-file ~/.conductor/shares/<shareId>/config.yaml
│             ├── daemonName : shared-alice-alice-mbp
│             ├── agentToken : B 的 daemon_share scoped token
│             ├── env: CONDUCTOR_HOME / CONDUCTOR_WS / CONDUCTOR_FIRE_STATE_DIR
│             │        ← 缺一不可，见「陷阱 0」；config 文件管不到这些
│             └── 拉起的 fire 子进程天然带 B 的身份
└── ~/.claude, ~/.codex …                  ← 共用（这就是需求本身）
```

**一个已经就位的关键前提**：`cli/src/daemon.js:831` 的
`allowEnvConfigOverrides = !config.CONFIG_FILE` + `envForExplicitConfigFile()` ——
显式传 `--config-file` 时，daemon **会忽略环境里继承来的 `CONDUCTOR_AGENT_TOKEN` /
`CONDUCTOR_BACKEND_URL`**。guest 是 A 的 daemon 的子进程，环境里必然带着 A 的 token；
没有这个行为，guest 会静默地用 A 的身份连上去，整个功能从根上就错了。
这个行为是 0.10.0 修 fire/diagnose 时顺手建立的
（`claw/lessons/stable_fire-explicit-config-env-override-4002-20260827.md`），
本 feature 直接受益。**要加回归测试钉死它。**

supervisor 的职责：
- 启动时 `GET /api/daemon-shares/mine`，为每个 `active` share 拉起一个 guest。
- 收到 `daemon_share_updated` 推送时增量增删。
- 退避重启（10s → 最多 5min），连续失败 N 次后标记 `unhealthy` 并上报，不无限重试。
- A 的 daemon 自更新 / 重启时：guest 一并退出，由新进程按 share 列表重新拉起（幂等）。
- 上限：每台 daemon 最多 3 个 guest（一人一进程，防止内存打爆）。

### B 侧的 UX：**大部分是白送的**

- `GET /api/agents` 直接返回 `getAgentsForUser(B)`，guest 连接一注册就出现，**零改动**。
- **跨 daemon 项目合并已经存在**（`web/src/lib/projects/grouping.ts` `canMergeProjectsByFields`）：
  同一个 user、同 `name`、**不同 `daemonHost`**、`gitRemoteUrl` 不冲突 → 前端合成一张卡片。
  也就是说 B 在自己笔记本上的 `myrepo` 和在共享机器上的 `myrepo` **会自动合并成一个项目**，
  B 建 task 时选机器即可 —— 「重活扔到高配机器上跑」这个核心场景**不需要写任何新前端**。
- 需要新增的只有「这台不是我的机器」的可见性：
  - `guestHost` 带 `shared-` 前缀。
  - `GET /api/agents` 补一个 `shared: true` + `ownerLabel` 字段（按 `granteeUserId + guestHost`
    join `DaemonShare`），前端在 daemon 选择器上打徽标。
- 建项目时 workspace 路径必须落在 guest root 之下：daemon 侧 `handleValidateProjectPath`
  加一个前缀检查，返回 `error_code: "outside_guest_root"`，前端给明确提示。

### A 侧的 UX

- Settings 的 daemon 卡片：「共享给同事」按钮 → 生成邀请链接；列出已共享给谁 + 撤销。
- 入口在前端，不在 CLI（见 Phase 2 第 1 条）。
- 一个 guest 在跑什么，A **看不到内容**（task 是 B 的），但看得到「有几个 guest、在跑几个 task」
  —— 这是 A 判断自己机器为什么变卡的必要信息。

## 全局状态争用（同 $HOME 带来的真问题）

这是本方案在「A 信任 B」前提下**真正需要设计**的部分。已按代码逐项核对，结论比预期严重：
**光换一个 config 文件是不够的**，daemon 有一批路径是 `os.homedir()` 硬编码或只认环境变量的。

### 陷阱 0：`--config-file` **不改** `CONDUCTOR_HOME`

`cli/src/conductor-paths.js` `materializeConductorPathEnv()` 只从 `env.CONDUCTOR_HOME`
解析，**从不**从 config 文件所在目录推导。所以
`conductor daemon --config-file ~/.conductor/shares/x/config.yaml`
依然把 sessions / logs / cache 写进 `~/.conductor`。

而 `WORKSPACE_ROOT` 默认 `$HOME/ws`，`LOCK_FILE = $WORKSPACE_ROOT/daemon.pid`
—— 两个 daemon 会抢同一个锁文件。带 `--force` 启动的那个会
`SIGTERM → SIGKILL` **掉 A 的 daemon**；不带 `--force` 则直接拒绝启动。

**guest 启动参数是硬性清单，少一个就出事**：

```
CONDUCTOR_HOME           = ~/.conductor-guests/<shareSlug>
CONDUCTOR_WS             = ~/conductor-guests/<shareSlug>/ws     # 决定 daemon.pid
CONDUCTOR_FIRE_STATE_DIR = ~/.conductor-guests/<shareSlug>/state
daemon_name              = <guestHost>                            # 否则两边都是 os.hostname()
```

（`envForExplicitConfigFile` 只删 token / backend 三个变量，不删 `CONDUCTOR_HOME`，
所以 supervisor 可以正常注入这些。）

### 逐项处置

| 全局状态 | 是否可隔离 | 处置 |
| --- | --- | --- |
| `$CONDUCTOR_HOME/{logs,sessions,cache,state}` | ✅ 环境变量 | 上面的清单 |
| `$WORKSPACE_ROOT/daemon.pid` | ✅ 环境变量 | 上面的清单 |
| `~/.codex/auth.json` | ❌ `homedir()` 硬编码 | **刻意共享**；但禁掉 `switch_account`（下详） |
| `~/.kimi-code/credentials/*.json` | ❌ | 刻意共享；`quota` 的 refresh 回写视为正常轮换 |
| Claude keychain / `~/.claude/.credentials.json` | ❌ | 刻意共享（这正是需求） |
| 全局 npm/pnpm prefix | ❌ | **guest 不广播 `restart_daemon`**（下详） |
| 共享 tmux server（无 `-L`/`-S`） | ❌ 目前无开关 | 记为已知问题，见下 |
| `~/.conductor/dsh-sessions` | ❌ 硬编码，无视 `CONDUCTOR_HOME` | DeepSeek 路径，MVP 记账 |
| `custom_commands` 脚本 | ✅ 天然隔离 | 相对路径锚定 guest config 目录，A 的命令不会被继承 |
| tmux session 名 | ✅ | taskId 是 UUID，不会撞 |

### 必须从 guest 的能力清单里减掉的三项

daemon 握手时广播 `x-conductor-capabilities`（`daemon.js:3018-3040`），guest 模式做减法：

1. **`ai_manager` —— 只禁 `switch_account`，读操作保留。**
   共享 AI 凭据是本 feature 的**出发点**，所以 guest 的 config **刻意不写 `envs:`**，
   让它继承 A 的 `~/.claude` / `~/.codex`（详见 RFC 0036 的 D 类）。
   但「共享凭据」≠「允许 B 轮换凭据」：
   - `switch_account` 会 `rename()` 覆盖 `~/.codex/auth.json`
     （`modules/ai-sdk/src/manager/account.ts:143-147`），
     **A 的 daemon、A 正在跑的 fire、A 手敲的 `codex` 会立刻全部变成 B 的账号**
     （连 `.bak` 一起被覆盖）。这是纯粹的破坏，必须禁。
   - `status` / `quota` / `list_accounts` 保留，而且**对 B 是有用的**：
     B 需要知道「这台机器的 Claude 还剩多少额度」才好决定要不要把活扔过来。
     在组内共享的信任模型下，`list_accounts` 暴露 A 的账号邮箱可以接受。
   注意 web 侧 `authorize()` 的鉴权是**对的**（B 有权驱动自己的 guest daemon），
   要拦的位置在 daemon 侧的 handler。

2. **`restart_daemon` —— 必须去掉或阉割。**
   带 `target_version` 时会走 `installCliVersion` → **全局** `npm install -g` /
   `pnpm add -g` + `pnpm config set --global onlyBuiltDependencies`。
   也就是 **B 点一下「重启 daemon → v1.2.3」，会把 A 的 daemon 和 A 所有 fire
   执行的那个 CLI 二进制升级/降级掉**。
   （纯自重启本身是安全的：handoff token 校验了 `from_pid` 和过期时间，
   `cleanupLock` 也只删自己的锁。所以可以只禁 `target_version`。）

3. **`remote_exec` —— 保持 `false`。** 原计划已有，理由现在更硬：
   `remote-exec-handlers.js` 给子进程构造 env 时会剥掉所有 `CONDUCTOR_*`，
   代码注释自己写着 *"the token still sits in `~/.conductor/config.yaml`,
   which an arbitrary command can simply read"*。

### 路径约束要覆盖两个 handler，不止一个

`validate_project_path`（`daemon.js:5432`）解析**任意绝对路径**，`create_if_missing`
时还会 `mkdirSync(recursive)`，然后回报 repo root / last commit / file count。
`get_project_agents` 同理。两个都不受 `WORKSPACE_ROOT` 约束，所以 guest root 前缀检查
要同时加在这两处，否则 B 能在 A 的 `$HOME` 里任意建目录、枚举 git 元信息。

## AI 额度是共享的 —— 这是产品问题，不是技术问题

既然共享 AI token 就是出发点，那么**额度争用从副作用升级为一等产品约束**：

- A 和 B 的 task 烧的是**同一个** Claude / Codex 订阅，撞的是**同一份** provider 限流。
  B 一口气开 3 个重活，A 自己可能就跑不动了。
- 这不是能靠隔离解决的问题（隔离了就没有共享了），只能靠**可见性 + 配额**：
  - `ai_manager` 的 `status` / `quota` 对 B 保留（见上），B 能看到「这台机器还剩多少」。
  - A 侧要能看到「几个 guest、在跑几个 task」—— 这是 A 判断自己机器为什么变慢/跑不动的必要信息。
  - **per-share 并发 task 上限**（建议默认 2），A 可调。这是 MVP 就该有的，
    不是打磨项：没有它，一次共享就可能让 A 当天用不了自己的机器。

### 一个需要实测的并发风险

A 的 fire 和 B 的 fire 同时刷新同一份 OAuth 凭据时会不会互相踩？
我们自己的写入是 tmp + rename 原子的（`manager/account.ts:143-147`），
但上游 CLI（claude / codex）自己的刷新逻辑不受我们控制。

注意这个风险**今天就存在**（单用户多 fire 并发同样共享凭据），
共享 daemon 只是把并发度和「不同人同时用」的概率放大。
列进 RFC 0036 Step 0 的实验清单里一起验证。

### 必须诚实告诉 A 的两件事

同 OS 用户模型下**无法用代码消除**，只能在共享确认页写清楚：

1. **guest 能读到 A 的 `~/.conductor/config.yaml`，也就是 A 的完整账号 token。**
   （tmux 模式下还多一条路：`tmux new-session -e CONDUCTOR_AGENT_TOKEN=…`
   把 token 存进共享 tmux server 的 session env，`tmux show-environment` 就能读。）
   注意这条的方向是反的 —— 我们本来在防「B 越权访问 B 之外的东西」，
   但**实际风险更大的是 A 把自己的账号暴露给了 B**。
   A 共享的是算力，附赠的是自己的 Conductor 账号。
2. **guest 的 resume 扫描会读 `~/.claude/projects`、`~/.codex/sessions`**
   （`modules/ai-sdk/src/resume/*.js`，`resolveHomeDir()` = `os.homedir()`），
   即 A 的历史 AI 会话记录对 B 的 daemon 可见。

这两条也是将来真要做隔离时，「换独立 OS 用户」的**真正收益所在**——
而不是防 B 跑坏 A 的机器。

## 信任模型（这才是这个 feature 的真正内容，需要拍板）

- **B 在 A 的机器上拿到的是任意代码执行**。这不是漏洞，这就是需求本身——AI agent 就是跑 shell 的。
  guest root 之类的限制**是防误伤，不是安全边界**，文档和代码注释里都要这么写，
  避免后人误以为它是。
- 定位既然是组内共享，立场就明确：**同 OS 用户 + 显式邀请 + 一键撤销**，
  UI 文案写死「只共享给你愿意给 SSH key 的同事」。
- 顺带说明为什么「换个 OS 用户跑」在这个定位下不划算：卖点就是复用 A 已登录的
  `~/.claude`，换用户就得把凭据复制过去，暴露面照旧，却多了一堆权限和路径问题。
- 其它已知代价：
  - B 的 task 烧的是 A 的 Claude/Codex 订阅额度，且和 A 自己的 task 抢同一份 provider 限流。MVP 不计量。
  - Task 配额算在 B 头上（task 行是 B 的），符合直觉。
  - 双向的 prompt injection / 数据外泄：B 的 agent 能读 A 的磁盘；A 能从本机日志读到 B 的 task 内容。
  - `realtimeHub` 仍是单进程 singleton（0034 已记录的既有约束），本 RFC 不改变这一点。

## Open Questions（想先和你对齐这几条）

1. ~~信任方向~~ ✅ 已定：组内共享，A 信任 B。
2. ~~共享 daemon 在 B 侧是一等还是二等公民~~ ✅ 已定：一等公民（复用全部现有 UI），
   但带 `shared-` 前缀 + 徽标，让 B 一眼看出文件系统不是自己的。
3. 共享粒度：整台 daemon，还是「daemon 上的某个目录子树」？
   MVP 建议整台 + guest root 约定（**约定不是边界**，见信任模型）。
4. 一台 daemon 最多共享给几个人？建议 3（Option C 是一人一进程）。
5. 和 RFC 0026 协作的关系：加入协作时要不要顺带提示共享 daemon？建议 MVP 保持正交。
6. 在跑的 task 遇到撤销：直接按断线处理，还是先 graceful stop？
7. ~~`ai_manager` 要不要禁~~ ✅ 已定：AI 凭据**刻意共享**（这是需求本身），
   只禁 `switch_account` 这个写操作，`status` / `quota` 保留给 B 看额度。
8. 共享确认页要不要把「A 的账号 token 对 B 可读」写成显式勾选项？倾向要 —— 这是
   A 最容易低估的一条，且无法用代码消除。
9. 共享 tmux server 目前没有 `-L`/`-S` 开关。要不要顺手加一个 per-daemon socket 配置？
   （不加的话：A 的 tmux server 被搞挂会连带 B 的 fire 一起死，反之亦然。）

## 实施分期

**Phase 0 — 前置修复（与本 feature 解耦，可先行合入）**
- `hub.ts` `sendToAgent(taskId, …)` 加 userId 约束（见「前置修复」一节的跨租户路由歧义）。
- `UserToken.scope` 字段 + `getLatestTokenValue` / `listTokens` / `approveDeviceAuthorization`
  三处加 `scope: "full"` 过滤。此时还没有任何 non-full token，纯属为下一期铺路，零行为变化。

**Phase 1 — 后端最小闭环**
- `DaemonShare` 模型 + migration（SQLite / Postgres schema parity）。
- 4 条路由：create / accept / list-mine / revoke。
- scope 强制：`getAuthUser()` allowlist + WS 握手 host 绑定 + `authenticateAgentRequest` host 绑定。
- 撤销时清 `AgentOutbox`。
- 此时用手写 config 文件 + 手动起 guest daemon 就能端到端跑通，**先验证核心假设再写 CLI**。

**Phase 2 — CLI supervisor**
- 只做 supervisor；分享的创建/撤销走前端，不加 CLI 子命令。
- supervisor：guest 生命周期 + 退避重启 + 幂等重建。
- guest 收紧开关：能力清单减去 `ai_manager` / `restart_daemon` / `remote_exec`；
  `validate_project_path` 与 `get_project_agents` 双双加 guest root 前缀校验；
  并发上限；缺 token 时 fail-fast（现在会回落到 `"default-agent-token"`）。
- 环境隔离清单（`CONDUCTOR_HOME` / `CONDUCTOR_WS` / `CONDUCTOR_FIRE_STATE_DIR`）+ 对应回归测试。
- `daemon_share_updated` WS 推送（可选，Phase 2 先用重连时拉取兜底）。

**Phase 3 — UI**
- A：daemon 卡片的共享入口 + 成员列表 + 撤销。
- B：邀请页 `/app/daemon-share/[token]`、daemon 选择器徽标（`shared: true` + `ownerLabel`）。

**Phase 4 — 打磨**
- 全局状态争用的逐项处理（见上一节）。
- A 侧的 guest 负载可见性（几个 guest、几个 task）。
- 审计记录。

## Test Strategy（草案）

- API：`/api/daemon-shares` 建/接受/撤销、上限、重复接受、非 pending 接受。
- 鉴权：`daemon_share` scope token 打非 allowlist 路由 → 403；host 不匹配的 WS 握手 → 4003；
  host 不匹配的 `authenticateAgentRequest` → 401；revoke 后 token 立即失效。
- token 隔离：铸完 share token 后，B 的 `/api/auth/tokens/latest`、`/api/auth/config`、
  设备授权都仍然返回 B 的 **full** token，不返回 share token。
- Hub：同一 host 名在 A、B 两个 userId 下并存互不串扰。
- CLI：supervisor 拉起/重启/撤销 kill；guest workspace root 越界路径被拒；
  guest 能力清单确实不含 `ai_manager` / `restart_daemon` / `remote_exec`。
- **环境隔离回归**：guest 进程的 `CONDUCTOR_HOME` / `CONDUCTOR_WS` 确实指向 guest 目录，
  且不因为继承了 A 的 env 而回落；`--config-file` 场景下不吃 `CONDUCTOR_AGENT_TOKEN`。
- E2E：本地起两个账号 + 一台机器，B 在 guest daemon 上跑通一个 ai_task。

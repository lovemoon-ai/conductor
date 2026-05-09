# 0024 端到端加密：消息传输与敏感信息保护

## Status

Proposed

## Owner

TBD

## Date

2026-04-30

## Summary

参考 Happy Coder（`slopus/happy`）公开的 E2EE 方案，为 Conductor 在 fire/daemon ↔ server ↔ browser/mobile 之间的所有敏感信息建立端到端加密通道。
核心思路：手机/浏览器持有不可导出的 Master Secret，账号级 Content Keypair 用于跨设备分发会话密钥，每个 Task/Session 拥有独立的 32 字节 DEK，所有 SDK 消息、Task 启动参数、Daemon/Fire 上报、WS 下行控制信令都以 DEK 加密后才进入 server 存储与转发；server 只保存密文与最小元数据（ids、时间戳、单调 seq、push token），不具备解密能力。本 RFC 仅做总体设计，后续按里程碑落地。

## Context

Conductor 当前仅依赖 TLS 防止链路被窃听，应用层完全是明文：

- `POST /api/agent/events`（RFC 0005）携带 `sdk_message`、tool 调用、tool 结果、文件内容、终端输出。
- `POST /api/tasks` 提交任务时包含 prompt、`workspace_path`、`env_json`。
- `/ws/agent` 下行投递用户消息、stop、tool approval；`/ws/app` 推送任务状态给浏览器。
- Daemon 注册/心跳上报 hostname、OS、CLI 版本、project 路径、git 分支等机器侧信息。
- 本地 `~/.conductor/state/agent-upstream-outbox.*.json` 与 `~/.conductor/config.yaml` 直接以明文写盘，agent_token 也是明文。
- Prisma 中 `Message.content`、`Task.launchConfig`、`Task.metadata`、`PtySession.env_json`、`AgentOutbox.payload_json`、`UserToken.token_value` 都以明文持久化。

可观测的风险面：

1. server 数据库泄露 ⇒ 历史任务的 prompt、代码、工具结果、env 全部暴露；
2. 自托管/第三方代理层（含未来的 channel-gateway，RFC 0007）拿到完整明文；
3. 任意一台 fire 主机被入侵 ⇒ 不仅是该机器，凡是经过该 token 的历史会话都可被攻击者从 server 拉回明文重放；
4. 即将上线的移动端 / Self-Host（RFC 0020）会进一步扩大跨网络面，明文传输不可接受；
5. 与 Happy Coder 等竞品相比，"零知识服务端"已成为该品类的基线安全承诺。

Conductor 的体量与 Happy 接近，且已经有 device-code 配对（RFC 0008）和稳定 id/outbox（RFC 0005）的基础，恰好可以在不重构传输的前提下叠加 E2EE。

## Goals

- 服务端对所有"内容性数据"零知识：prompt、completion、tool I/O、env、cwd、文件、终端输出、daemon 详情。
- 端到端密钥永不离开终端用户控制的设备（手机 / 浏览器 LocalKeystore），server 只见公钥与密文。
- 在 fire 主机被攻陷时，最小化爆炸半径：仅泄露该机器参与过的 session 的 DEK，不能反推 master secret 也不能解密其它 session。
- 与 RFC 0005 的 HTTP 上行 + WebSocket 下行架构正交，不引入新的可靠性协议。
- 与 RFC 0008 的 device-code 配对在同一 UX 流程内完成密钥交换，不增加用户操作步骤。
- 本地 at-rest：`outbox`、`config.yaml`、daemon log 中的敏感字段亦加密。
- 渐进式上线：保留 `protocol_version` 字段，老客户端在过渡期可继续工作。

## Non-Goals

- 不要求 forward secrecy 到每一条消息（不引入 Double Ratchet；session 级 DEK 已足够覆盖威胁模型）。
- 不重写传输层（HTTP/WS endpoint 路径与语义不变，只在 payload 上做包装）。
- 不解决"用户密码忘记/手机丢失" 的账号恢复——本 RFC 默认丢失 master 即丢失历史明文，恢复机制留给后续 RFC。
- 不加密 server 必须明文使用的元数据：`event_id`、`task_id`、`stable_id`、`seq`、`created_at`、`agent_host`（匿名 ID）、push token、HTTP 路由所需 header。
- 不替换现有 Bearer token 鉴权 —— 鉴权与加密是两个独立维度，本 RFC 不动 RFC 0008。
- 移动端 App 本身的实现细节不在本 RFC 范围。

## Options Considered

### Option A：仅做服务端字段级加密（KMS/DEK，密钥由 server 持有）

- Pros：实现成本极低，只需在 Prisma 层加一层 cipher；用户体验完全透明；可复用 AWS KMS / 火山 KMS。
- Cons：server 仍能解密，等同于"加固的明文"——无法对抗 server 数据库泄露与内鬼场景；没有竞品级的 E2EE 营销价值；channel-gateway/Feishu 转发节点依然看到明文。

### Option B：TLS-only + 强化运维（不做 E2EE）

- Pros：零工作量。
- Cons：与 Goals 相悖；Self-Host 与移动端上线后将被对标方案碾压。

### Option C：完整 Signal 协议（X3DH + Double Ratchet，per-message FS）

- Pros：业界最高安全等级，每条消息独立棘轮密钥。
- Cons：协议复杂度极高，多设备同步与历史消息可读性需要额外设计；与 Conductor 的 fire/daemon 长会话特性不契合（agent 不是即时通讯客户端）；落地周期与维护成本远超 Happy 的 NaCl + per-session DEK 模式。

### Option D（推荐）：Happy 风格的分层密钥 + per-session DEK

- Pros：
  - 4 层密钥结构（Master / Content / Machine / Session DEK）已被 Happy 在生产验证，威胁模型清晰；
  - 与 Conductor 的"每个 task 一个上下文"天然契合，DEK 与 task 1:1；
  - 仅依赖 libsodium（TweetNaCl 兼容），无需自研协议；
  - 配对流程可与 RFC 0008 device-code 复用同一 QR；
  - server 改造极小：新增 envelope 字段 + 公钥目录，无需触碰已有路由。
- Cons：
  - 不提供 per-message forward secrecy（DEK 在 session 生命周期内长期有效）；
  - 多终端加入需要"已有设备主动 wrap DEK 给新设备"的手工同步路径；
  - 账号恢复弱（master 丢失即历史不可读）。

**结论：采用 Option D。** 后续若有进一步需求，可在 session DEK 上增加棘轮，不改变上层结构。

## Proposed Design

### 1. 密钥分层（与 Happy 对齐，命名贴合 Conductor 实体）

```
┌─────────────────────────────────────────────────────────────┐
│ MasterSecret  (32B, CSPRNG, 仅 mobile/web 可信终端持有)     │
│   └─HKDF─┬─> ContentKeyPair    (X25519, 账号级长期身份)     │
│          ├─> SignKeyPair       (Ed25519, 设备/事件签名)     │
│          └─> LocalStorageKey   (XSalsa20, at-rest 加密)     │
└─────────────────────────────────────────────────────────────┘
                       │ wrap + 通过 server 分发
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ MachineKeyPair  (X25519, 每台 fire/daemon 一份)            │
│   QR pair 时由用户终端 sealedbox 给 ephemeral 公钥          │
│   存储于 ~/.conductor/keys/machine.key（XChaCha20 加密）   │
└─────────────────────────────────────────────────────────────┘
                       │ wrap session DEK
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ SessionDEK   (32B AES-256, 每个 Task/Session 一份)         │
│   每个授权设备/机器都收到一份 box(DEK, recipient_pub, ...)  │
│   实际加密 sdk_message / launchConfig / tool_io / pty out  │
└─────────────────────────────────────────────────────────────┘
```

KDF 约定：`HKDF-SHA256(master, salt = "conductor/v1", info = "<purpose>")`，purpose 取 `content`、`sign`、`local-storage` 等显式字符串。

### 2. 配对流程（复用 RFC 0008 device-code）

device-code 现有 5 步流程（CLI start → user approve → CLI poll → token issue）维持不变，仅在 `approve` 这一步把密钥交换塞进同一次往返：

1. CLI/daemon 启动时本地生成 `EphemeralKeyPair`（X25519，pair 完成后立即销毁）。
2. `POST /api/auth/device/start` 请求里附带 `ephemeral_pub`、`machine_info`（hostname/os/cli_version 已 box 到自身 ephemeral_pub，等价 sealedbox-self，仅作为待迁移占位）。
3. 用户终端扫码 / 输入 user_code 进入审批页：
   - 审批页用本地 `ContentKeyPair` 生成 `MachineKeyPair`（实际：派生一个机器专用子密钥），并用 `nacl.box(machine_priv, ephemeral_pub, content_priv, content_pub)` 包装；
   - 同时把当前账号下"机器需要参与"的 `SessionDEK[]` 用 `nacl.box(dek, ephemeral_pub, …)` 批量包装；
   - 将 `wrapped_machine_key` + `wrapped_deks[]` + `account_content_pub` 提交给 server。
4. server 把这些密文挂在 `DeviceAuthSession` 记录上，不能解密，仅做"信箱"。
5. CLI poll 命中 approved，拿到 agent_token + 上述 envelope，用 `ephemeral_priv` 解出 MachineKeyPair 与初始 DEKs，写入本地加密 keystore，销毁 ephemeral。

UX 上对用户没有任何额外步骤——和今天扫码登录完全一致，只是审批页背后多做了一次 box。

### 3. 加密信封统一格式（Envelope v1）

无论走 HTTP 还是 WebSocket，所有承载敏感内容的字段都包成同一个对象：

```jsonc
{
  "v": 1,                          // protocol_version
  "alg": "xchacha20poly1305",      // 或 "aes-256-gcm" 二选一固定
  "kid": "session:<task_id>",      // key id，server 据此路由 wrapped key 列表
  "n": "<24B base64url nonce>",    // 每条消息独立随机 nonce
  "ct": "<base64url ciphertext+tag>",
  "aad": {                         // 绑定到上下文，防重放/串改
    "task_id": "...",
    "event_id": "...",
    "event_type": "sdk_message",
    "seq": 173,
    "ts": 1714492800
  }
}
```

AAD（Additional Authenticated Data）在握手 sign 时一并校验；server 拒绝 `aad.task_id` 与路由 path 中 task_id 不一致的请求。

### 4. 各传输面的处理

#### 4.1 HTTP 上行（`POST /api/agent/events`）

- `events[i].payload` 由原 JSON 替换为 Envelope。
- `events[i]` 顶层保留 `event_id`、`event_type`、`task_id`、`agent_host`、`created_at` 明文，供 server 做幂等写入与 outbox 路由（与 RFC 0005 完全兼容）。
- server 写入 `AgentOutbox.payload_json` 时直接保存 envelope，**不解密、不再处理 schema**。

#### 4.2 WebSocket 下行（`/ws/agent`）

- server → fire 的所有控制消息（user message、stop、tool approval、restart）由 web 控制台/移动端在发送前完成加密，server 仅做转发与按 `seq` 重放（RFC 0006/0005 Phase 3 的语义照旧）。
- 新增字段：`payload` 为 Envelope，`seq`、`command_id`、`task_id` 留在外层明文。
- server 不能再像今天那样自己构造业务 payload 推送给 fire；所有"业务消息"必须由具备密钥的客户端构造。系统级控制（restart、ping）保持明文，但限于不含用户内容。

#### 4.3 浏览器 ↔ server（`/ws/app`、`/api/tasks`）

- 浏览器内的 web app 同样持有 ContentKeyPair（基于 user 登录后从 `IndexedDB` 读取或首登记诱导生成），对外发送的 prompt/launchConfig 在前端就完成加密，server 拿到的也是 envelope。
- 浏览器收到推送时按 `kid` 在本地查 DEK 解密后再渲染。

#### 4.4 Daemon 注册 / 心跳

- Daemon 上报的 hostname/os/path/git 信息走 `POST /api/agent/events` 中新增的 `event_type = daemon_info`，payload 走 envelope 加密。
- 心跳 ping 仅含 `agent_host` + `ts` + `seq`，明文允许（无敏感内容）。
- 移动端在线列表展示时再解密 `daemon_info` 的最近一条快照。

#### 4.5 PTY / 终端输出（RFC 0012）

- 现有 `pty_chunk` 上行携带终端输出，全部纳入 envelope。
- 与 channel-gateway（RFC 0007）的 Feishu/IM 转发：转发节点必须使用各自的接收方公钥重新封装；server 不会向不在密钥目录中的 channel 推送可读内容。

### 5. 本地 at-rest 加密

- `~/.conductor/state/agent-upstream-outbox.*.json`：每条记录的 `payload` 字段在 `DurableUpstreamOutboxStore.saveUnlocked()` 出口处用 `LocalStorageKey` 通过 `nacl.secretbox` 加密；外层结构（stableId/eventType/attempt/lastAttemptAt）保持明文以便恢复扫描。
- `~/.conductor/config.yaml`：`agent_token` 字段拆出，存到 `~/.conductor/keys/credentials.enc`，使用 `LocalStorageKey` 加密；其它配置（backend_url、daemon_name）维持明文方便排错。
- `~/.conductor/keys/`：新建目录，权限 `0700`。`MachineKeyPair` 与 `LocalStorageKey` 用一份"密钥加密密钥（KEK）"再加一层；KEK 来源优先级：
  1. macOS Keychain / Linux libsecret / Windows DPAPI（OS keystore）；
  2. 退化为 PBKDF2(用户口令)（首次启动提示设置；headless 服务器场景可由 env 提供）；
  3. 最低降级：明文 + 文件权限 0600（仅自托管单机部署场景，启动时打 WARN）。
- `Prisma.UserToken.token_value`：迁移成只存 `token_hash` + `token_prefix`，明文 token 仅在签发时返回客户端；与 E2EE 无强耦合，但顺手补齐。

### 6. 服务端改动概览

- 新增 `PublicKeyDirectory` 表：`(user_id, kid, owner_type ∈ {user, machine, channel}, public_key, created_at, revoked_at)`。客户端轮询/订阅自身 `kid` 列表用于决定 DEK 要 wrap 给谁。
- 新增 `WrappedKey` 表：`(kid, recipient_kid, ciphertext, sender_kid, created_at)`，作为 DEK 信箱；客户端首次解锁 task 时拉取自己对应的密文。
- `AgentOutbox.payload_json`、`Message.content`、`Task.launchConfig`、`PtySession.env_json` 改为 BYTEA / Text 存储 envelope；schema 字段名加后缀 `_envelope` 标识。
- `/api/agent/events` 强制要求 `payload.v >= 1`，并校验 `aad.task_id` 与外层一致。
- 推送给 `/ws/app` 的 broadcast 直接转发 envelope，前端解密后渲染。

### 7. 协议版本与降级

- 在登录、device-code 起始、ws 握手三处都协商 `protocol_version`；
- v0：今日的明文协议；v1：本 RFC；server 在过渡期同时接受 v0/v1，按客户端能力开关；
- 一旦集群 v1 客户端比例 >= 95%，发布版本拒绝 v0 上行，仅保留只读兼容用于历史回放。

### 8. 密钥轮换 / 撤销

- 终端可主动 `POST /api/keys/revoke` 把某 `machine_kid` 标记 revoked；server 之后下发的新 DEK 不再 wrap 给该 kid，老 session 的内容仍可在被攻陷机器上离线解密（这是 Option D 的固有限制，威胁模型已声明）。
- 用户可以 `rotate-master` 重新派生 ContentKeyPair；该流程会强制所有机器重新 device-code 配对。

### 9. 与既有 RFC 的关系

- **RFC 0005**：本 RFC 在其 `payload_json` 上叠加密，事件结构与幂等语义不变。
- **RFC 0006**：可靠重放维持 `seq`/cursor 不变，envelope 透明转发。
- **RFC 0007 channel-gateway**：channel 必须在 PublicKeyDirectory 注册公钥，否则不接收业务消息；本 RFC 是其上线的安全前置。
- **RFC 0008 device-code**：审批页扩展为同时分发 wrapped DEK，无新增 UX。
- **RFC 0014 tool-approval**：approval 请求/响应同样走 envelope。
- **RFC 0020 self-host bootstrap**：自托管部署本身不再需要信任 server 内容路径。

## 影响面与副作用

E2EE 上线对现有功能并非完全无感。本节按"主路径无感 / 微感 / 必须重做"三档明确列出，便于评审与产品决策。

### 1. 真正无感（用户无感知）

| 功能 | 为什么无感 |
|---|---|
| 扫码登录 / device-code 配对 | 密钥交换塞在审批页一次往返里，UX 不变（仅 +200ms p95） |
| `conductor fire "..."` 发任务 | 加解密在 SDK 内做，CLI 命令、参数完全不变 |
| 消息收发延迟 | XChaCha20 单条 < 1ms，HTTP/WS 协议路径不变 |
| 任务执行正确性 | 与 RFC 0005 正交，不动 outbox / 幂等 / 重放语义 |
| 现有 Bearer token 鉴权 | 鉴权与加密两条独立维度，token 流程不变 |

### 2. 微感（功能仍可用，行为略变）

| 功能 | 变化 | 用户感知 |
|---|---|---|
| Web 控制台首屏 | 浏览器需先用 IndexedDB 中的密钥解密任务列表内容 | 首屏多一次解密，可能晚 50-200ms 渲染 |
| 任务详情切换 | 进入未缓存的 task 要按需解密 | 偶发短暂"加载中" |
| 多设备同步 | 新设备首次进入要等已有设备解锁分发 DEK | **若主设备离线，新设备看不到历史**——UI 必须显式提示并提供"待分发"队列 |
| 推送通知 body | server 不能把 prompt 摘要塞进 push body | 通知会从"用户问：xxx" 退化成"你有新消息"，除非客户端预生成明文摘要写回（见 §4 折中） |
| `~/.conductor/config.yaml` 直接编辑 | `agent_token` 不再以明文存在 | 习惯手改 token 的高级用户需走 CLI 命令（如 `conductor auth set-token`） |

### 3. 必须接受的功能折损 / 重设计

这些是"零知识服务端"的固有代价，Happy Coder 也是同样取舍。落地前需逐项明确处理策略：

1. **server 端全文搜索 task / message 失效**
   - 现状：能按 prompt/title 模糊搜。
   - 加密后：server 只能按元数据（task_id、时间、agent_host）搜。
   - 处理：客户端建索引（SQLite FTS / Tantivy）；跨设备搜索受限，仅检索本地已解密内容。

2. **Channel-Gateway（RFC 0007，Feishu / IM 转发）必须重做**
   - 转发节点必须先在 PublicKeyDirectory 注册公钥，才能拿到可读内容。
   - 否则 Feishu 卡片只能展示"任务 #1234 有更新"，不能展示 prompt 片段。
   - 处理：见 §4 "Confirmed Trade-offs" 之"明文摘要字段"。

3. **管理后台 / 客服排障能力下降**
   - 管理员、SRE、客服在 admin 后台**看不到任何任务内容**，仅元数据。
   - 用户报"任务跑错了" → 必须在端侧导出脱敏样本上传，无法直接查 DB。
   - 处理：客户端提供"一键导出当前 task 完整密文 + 解密样本"工具；企业自托管可选 break-glass（见 §4）。

4. **server-side 自动化逻辑必须迁移到端侧**
   - 例：自动生成 task 标题摘要、基于内容判断任务类别、token 用量统计。
   - 加密后必须在客户端做完再写回 envelope（或写回 §4 的明文摘要字段）。
   - token 计费数字由客户端带签名上报，server 不再自算。

5. **数据导出 / 备份 / 增量同步**
   - 现状：直接 SQL dump 或 `GET /api/tasks/export` 拿 JSON。
   - 加密后：导出物为 envelope，必须经过客户端 SDK 解密管道。
   - RFC 0010 增量同步的 server-side diff 退化为"黑盒 envelope diff"——能正常工作但失去内容级 diff。

6. **master 丢失 = 历史不可读**
   - 与 Happy 同款风险，是 Option D 的固有代价。
   - 强制配套"导出加密备份 / 12 词助记符"功能，并在产品上**显著告知**——这是新增的用户责任。

7. **自托管的"运维可读"承诺消失**
   - 部分企业用户希望"我自己的 server 上能看见自己的数据"，与 E2EE 直接冲突。
   - 处理：见 §4 "企业版 break-glass SKU"。

### 4. Confirmed Trade-offs（已确认的折中点）

为保住"主路径无感"，本 RFC 在两个边界上不再追求严格 E2EE：

#### 4.1 Envelope 之外保留"明文摘要"字段

新增可选明文字段，由用户终端在加密前生成并随 envelope 一起提交：

- `Task.plaintext_title`：task 标题（≤ 80 字符），用于 Feishu 卡片、推送 body、search ranker。
- `Message.plaintext_preview`：消息摘要（≤ 160 字符），客户端裁剪后写入；仅用于通知/列表预览。
- 客户端可选关闭（隐私偏好），关闭后通知/卡片退化为"你有新消息"。
- 字段语义对外文档化为"非 E2EE 范围，server 可读"，避免误导。

适用面：Channel-Gateway、Push Notification、列表搜索 ranker、admin 列表概览。

#### 4.2 自托管企业版可选 break-glass 模式

- 默认仍是零知识；企业管理员显式开启后，server 持有一份与用户公钥并列的"组织主公钥"，所有 DEK 同时 wrap 给该公钥。
- 管理员私钥由 HSM / KMS 托管，访问产生审计日志（写入独立审计 DB，不可篡改）。
- 该模式与社区版 / SaaS 版不互通；客户端启动时必须显示"本部署已开启 break-glass"横幅，避免误以为是零知识环境。
- 由独立 SKU / feature flag 控制，默认关闭；社区版构建直接编译时移除该路径以防误用。

### 5. 服务端 / 开发体验（用户不可见但需投入）

- **Debug 困难**：server log 中 payload 全部为 base64 envelope；排障依赖端侧 trace + 用户主动上传脱敏样本。新增端侧 `conductor diag dump --task <id>` 命令。
- **CI / 测试**：所有涉及消息内容的集成测试要带密钥 mock；`web/tests/` 与 `modules/conductor-sdk/tests/` 都需补 fixture。
- **过渡期 v0/v1 双协议**：Phase 2-3 期间 server 双写两份 schema；迁移脚本与回滚预案需严格演练。
- **历史明文回填**：Phase 4 的后台 re-encrypt 需在线设备协助；不可 wrap 的 task 标记 `legacy_plaintext`，UI 显著提示——这是一次有用户感知的迁移事件，需提前公告。
- **可观测性**：现有基于 prompt 内容的运营看板（如"今日热门任务关键词"）失效；新看板只能基于明文摘要字段或客户端聚合上报。

## Risks

- **复杂度上升**：客户端首次集成 libsodium 与 keystore 抽象会增加 fire/web 的依赖；需要在 `modules/conductor-sdk` 中沉淀统一 `crypto/` 模块。
- **多设备分发滑铁卢**：若主设备离线，新设备无法立即拿到历史 DEK；需要"待分发队列"+ 推送提醒主设备解锁分发。
- **密钥丢失即数据丢失**：master 丢失意味着历史任务永远不可读；产品上必须明确告知，并提供"导出加密备份"功能（带恢复 phrase）。
- **错误使用 nonce / IV 重用**：所有加密都使用 24B 随机 nonce + counter 监督；CI 加 lint 阻止 `nacl.secretbox(..., 0)` 等危险写法。
- **性能**：单条 sdk_message 加密成本 < 1ms；but PTY 高频流可能成为热点，需要批量 chunk。
- **端到端调试困难**：server 不再能 grep 内容；必须在客户端侧补 trace + 用户主动上传脱敏样本。
- **向下兼容窗口**：v0/v1 并存阶段 outbox 同时存在两种 payload，迁移脚本需谨慎。

## Rollout

按四个里程碑推进，每个里程碑独立可发布。

### Phase 1：基础设施（不影响现有用户）

- 在 `modules/conductor-sdk/src/crypto/` 落地 libsodium 包装（key derivation、envelope 编解码、nonce 管理）。
- web 端引入同一份 crypto，补齐 `IndexedDB` keystore 抽象。
- Prisma 增加 `PublicKeyDirectory`、`WrappedKey`，字段双写（仍保留明文）。
- `protocol_version` 协商上线。

### Phase 2：device-code 配对带密钥（先在 fire 启用）

- 审批页生成 MachineKeyPair + 初始 DEKs，写入 envelope 信箱。
- fire 启动后写入 `~/.conductor/keys/`，本地 outbox 切到加密写盘。
- v1 客户端发往 `/api/agent/events` 的 payload 强制为 envelope；server 双写：解密失败时回落明文（仅过渡期）。

### Phase 3：浏览器与移动端发送侧加密

- web 控制台所有 `POST /api/tasks` 与 `/ws/app` 上行换为 envelope。
- 移动端 app 接入；Channel-gateway 接入并强制 PublicKeyDirectory 注册。

### Phase 4：清理 v0

- server 拒绝 v0 业务 payload。
- 历史明文做一次后台 re-encrypt（基于在线设备分发 DEK），无法 wrap 的旧 task 标记 `legacy_plaintext`，UI 显著提示。
- `UserToken.token_value` 明文列删除。

迁移脚本与回滚预案：

- 每个 Phase 都保留 `feature_flag = e2ee.v1.<phase>` 灰度；
- Phase 2/3 出问题时只需关 flag，server 同时回落到 v0；
- Phase 4 不可逆，发布前必须验证全网客户端版本分布。

## Acceptance

- [ ] fire/daemon、web 控制台、移动端三端均默认启用 v1 协议，server 拒绝同账号下的明文业务 payload。
- [ ] server DB 抽样：`Message.content`、`Task.launchConfig`、`AgentOutbox.payload_json`、`PtySession.env_json` 全部为 envelope；任何一条都无法在 server 进程内解密（pen-test 验证）。
- [ ] `~/.conductor/state/*` 与 `~/.conductor/keys/*` 在文件系统层均为密文，`agent_token` 不再以明文出现在 `config.yaml`。
- [ ] 任意一台 fire 主机被取走完整磁盘镜像后，攻击者只能解出该机器参与过的 session，**不能**解出同账号其他 session 或 master secret（红队演练）。
- [ ] device-code 配对在不增加用户操作步骤的前提下，完成一次密钥交换；端到端登录耗时新增 < 200ms（p95）。
- [ ] `protocol_version` 协商打通，v0 客户端在过渡期可正常工作；过渡期结束后给出明确升级提示。
- [ ] 提供"导出加密备份 / 恢复 phrase"流程，用户在主设备丢失后能在新设备恢复 master secret。
- [ ] CI 中加入 nonce 重用 / 弱算法的静态检查；新加 `pnpm test` 用例覆盖 envelope 编解码、降级、密钥轮换。

## Open Questions

1. ~~server 端是否需要保留"运维可读"的应急通道（带审计日志的 break-glass key）？~~ → 已决：见"影响面与副作用 §4.2"，作为可选企业 SKU，默认关闭。
2. 多终端 DEK 分发的"主设备离线"问题如何在 UX 上呈现？是否需要桌面 web 也具备"主设备级"权限以避免单点。
3. `agent_host` 当前是基于 hostname 派生的可读字符串，是否应改为完全随机 ID 以防止侧信道（hostname 可能本身就是敏感信息）？
4. PTY 高频流加密下的批量大小、压缩与 envelope 复用策略：是否需要"DEK + 子流密钥"以避免 nonce 空间耗尽。
5. 与现有 `/api/auth/device/poll` 长轮询的兼容：wrapped DEK 体积在大量并发 task 时是否需要拆分接口（单独 `/api/keys/inbox`）。
6. ~~自托管 / 私有化部署版本是否提供"server 持有解密密钥"的退化模式（合规但牺牲零知识）作为可选 SKU。~~ → 已决：见"影响面与副作用 §4.2"。
7. ~~与 RFC 0007 channel-gateway 的 IM 推送：Feishu 卡片在 server 不解密的前提下，能否仍然展示 task 标题。~~ → 已决：见"影响面与副作用 §4.1"，引入可选 `plaintext_title` / `plaintext_preview` 字段。
8. 客户端本地 FTS 索引（取代 server 端搜索）的体积上限与跨设备同步策略尚未明确。

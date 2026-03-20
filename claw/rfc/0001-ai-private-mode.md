# 0001 AI Private Mode

## Status

Proposed

## Owner

TBD

## Date

2026-03-19

## Summary

本文提出 Conductor 的 `AI Private Mode`：在用户显式打开后，AI task 的消息内容、回复内容、运行时预览和历史正文都以端到端密文形式在系统中传输与存储，Conductor server 只保留控制面与密文 relay 能力，不能看到明文内容。该模式会牺牲一部分依赖服务端明文的功能，因此必须作为显式开关提供，并在 UI 与配置中明确标注降级影响，默认保持关闭。

核心判断：对“数据是否经过 server”的担忧，本质上是“server 能否读取内容”的担忧。相比 browser/daemon 完全绕过 server，AI Private Mode 选择“server blind relay + end-to-end encryption”路线，在保留 task 生命周期、鉴权、ownership、重连恢复和消息 durable delivery 的同时，让 server 对 AI 内容不可见。

## Context

当前 AI task 的消息链路中，server 可以直接看到明文内容：

- 用户消息通过 `POST /api/tasks/[taskId]/messages` 进入服务端，服务端直接落库明文。
- `appendUserMessageToTask()` 会把用户消息以明文写入 `messages.content`，并投影给 realtime / channel 路径。
- assistant 回复通过 `commitSdkMessage()` 在服务端以明文落库并广播。
- `task_runtime_status` 中的 `status_line`、`status_done_line`、`reply_preview` 也可能泄漏回答内容。
- 任务创建时的 `initialContent` 当前也可能进入 task metadata 或 message history。

这意味着：

- 即使后续把 browser 和 daemon 做成 direct transport，只要服务端仍收到明文镜像，用户对“server 能看到聊天内容”的担忧就不会消失。
- AI task 与 PTY task 不同。PTY direct 主要解决的是低延迟字节流问题；AI chat 更核心的是 durable message、历史、幂等、replay 和多端同步。简单复制 PTY direct 不能解决隐私目标。
- 当前系统中，server 还承担 task routing、ownership、outbox、replay、auth、UI 投影等职责。完全绕过 server 意味着要重做整套控制面和消息可靠性语义，代价很高。

用户反馈集中在“Conductor server 不应看到我的 prompt / reply 明文”。因此本 RFC 聚焦“server 不可见内容”而不是“server 完全不参与消息路径”。

## Goals

- 在用户打开 AI Private Mode 后，Conductor server 不能读取 AI task 的消息明文、回复明文和运行时文本预览。
- 保留现有 task control plane：auth、ownership、stop、resume、outbox、replay、status lifecycle 仍由 server 掌控。
- 将 private mode 设计为显式开关，默认关闭；用户可通过前端 `Settings` 决定默认是否打开。
- 明确 private mode 下会失去或降级哪些功能，并在 UI/文档中提前告知。
- 允许未来在不改变 trust model 的前提下扩展到附件、多设备解密、私有 channel 等能力。

## Non-Goals

- 本 RFC 不要求 AI task 在 private mode 下完全绕过 server。
- 本 RFC 不尝试隐藏所有 metadata；server 仍可能看到 task id、user id、agent host、时间戳、消息长度区间、状态流转等控制面信息。
- 本 RFC v1 不要求支持附件端到端加密。
- 本 RFC v1 不要求支持跨设备无缝查看 private task 历史。
- 本 RFC 不解决“本机被攻破后内容泄漏”的终端安全问题。
- 本 RFC 不把 PTY task 纳入 private mode 范围。

## Options Considered

### Option A：继续维持现状，仅增加隐私说明

优点：

- 实现成本最低。
- 不影响任何现有功能。

缺点：

- 不能回答“server 能否看到我的消息内容”这个核心问题。
- 用户安全感与实际 trust model 没有改善。
- 需要在隐私文案里继续承认服务端可见明文。

### Option B：browser / daemon 完全绕过 server 直接通信

优点：

- 从表面路径上最接近“消息不经过 server”。
- 理论上可以把内容留在端侧。

缺点：

- 需要重做 durable message、ack、history、reconnect、ownership、multi-viewer / multi-device 语义。
- AI task 真正执行者经常是 `conductor-fire`，不是长期常驻 daemon，本地路径更复杂。
- NAT、证书、P2P、代理与 fallback 复杂度高。
- 一旦回退 relay，仍然要重新面对明文可见性问题。

### Option C：server blind relay + end-to-end encryption（Chosen）

优点：

- 直接解决“server 不能看到内容”的问题。
- 保留现有 server control plane、routing、durability、replay 和 auth 模型。
- 比“完全绕过 server”更适合现有 Conductor 架构。
- 可以按 task / user / daemon 渐进灰度。

缺点：

- 需要引入密钥管理与浏览器本地密钥缓存。
- 部分依赖服务端明文的功能必须降级或关闭。
- 多设备历史与 server-side 预览能力会明显受限。

## Proposed Design

### 1. 模式定义

新增 AI task 运行模式：

- `standard`：默认模式；现有行为不变，server 可见明文。
- `private`：AI Private Mode；server 只见密文，不见消息正文。

private mode 必须是显式 opt-in；禁止在用户未确认的情况下静默升级。

### 2. 配置与开关设计

#### 2.1 前端 Settings 默认开关

AI Private Mode 的“默认值”只放在前端 `Settings` 中，不放入本地 `~/.conductor/config.yaml`。

原因：

- private mode 是用户可感知的隐私产品能力，不是纯运行时参数。
- 打开后会损失功能，必须在 UI 中伴随明确说明，而不是藏在本地 YAML 中。
- 当前 private mode v1 的 key generation / local key cache 主要锚定在浏览器端；让 daemon / fire 通过本地 config 静默改变默认值，容易造成用户心智混乱。

因此 Web/App 应提供：

- `Settings` 中的 `AI Private Mode 默认开启` 开关
- 与该开关配套的功能损失说明、能力检查和帮助文案

该默认值仅影响“新建 AI task 时 UI 的初始选中状态”，不改变单个 task 的最终显式选择。

#### 2.2 Task 级显式开关

在 AI task metadata 中新增：

```json
{
  "privacy": {
    "ai_private_mode": true
  }
}
```

该字段作为 task 的权威模式标志；一旦 task 创建为 private mode，后续消息流、回复流和历史读取都必须按 private 语义执行，禁止中途 silent downgrade。

同时明确：

- private mode 只能在创建 task 时决定
- task 创建后不可在 `standard` 与 `private` 之间切换

原因是避免同一 task 出现“部分历史明文、部分历史密文”的混合状态。

#### 2.3 创建任务时的显式覆盖

`CreateTaskDialog` 必须提供 task 级 `Private Mode` 开关，用于覆盖 Settings 默认值。

优先级：

- `CreateTaskDialog` 中用户当前选择
- 高于 `Settings` 中的默认值

换言之：

- `Settings` 负责“默认选中什么”
- `CreateTaskDialog` 负责“这个 task 最终是不是 private”

#### 2.4 CLI / headless 约束

v1 不在本地 CLI config 中增加 private mode 默认项。

`conductor fire` / headless 创建 task 若要进入 private mode，应采用：

- 显式参数，例如 `--private`

而不是：

- 本地 YAML 默认值
- daemon 侧隐式默认开启

这样可以保持隐私语义显式、可审计、可预期。

同时，RFC v1 明确要求 private mode 的加密模型同时覆盖两类 task 创建入口：

- **app 发起 task**：由 Web/App 创建 private task，再交由 daemon / fire 执行
- **manual fire 发起 task**：由 `conductor fire --private` 直接创建 private task 并执行

两类入口都必须满足同一个 trust model：

- server 不得看到 prompt / reply 明文
- server 可继续承担 auth、routing、durability、replay
- private 语义必须是显式 opt-in，不允许 silent fallback

#### 2.5 UI 文案要求

UI 文案必须明确：

- 打开后，Conductor server 无法看到消息内容
- 某些功能会受限
- 若当前 agent / daemon 不支持 private mode，则不能创建 private task

#### 2.6 默认策略：v1 不做 default-on

虽然 Happy 一类产品更接近“encryption-first / default encrypted”的系统设计，但 Conductor v1 不应把 AI private mode 作为默认行为。

v1 保持以下策略：

- private mode **默认关闭**
- 用户通过 `Settings` 决定自己的默认创建偏好
- `CreateTaskDialog` / `conductor fire --private` 负责显式选择某个 task 是否进入 private mode

当前不做 default-on 的原因：

- Conductor 现阶段仍是“现有 task 系统上的 private lane”，不是从底层开始按密文优先建模
- private mode v1 仍会损失部分能力，例如搜索、预览、摘要、channel sync、多设备历史
- app-created 与 fire-created private task 虽然都已纳入设计，但跨 endpoint 的 key sharing 还不是 v1 范围
- 默认加密会显著提高诊断、客服支持与故障排查成本

因此产品建议是：

- v1：显式 opt-in
- v2 之后：当功能差距、运维成本和多端体验足够收敛后，再评估是否对新用户 default-on

重新评估 default-on 前，至少应满足：

- app-created 与 fire-created private task 都稳定可用
- fire-created private task 在 app 侧的展示与解密策略已明确
- 多设备 / key recovery 有清晰方案
- diagnostics / support 在 server 不见明文的前提下仍可工作
- 不存在任何 silent downgrade 到明文路径

### 3. Threat Model 与可见性边界

private mode 下，server **不可见**：

- 用户消息正文
- assistant 回复正文
- `reply_preview` / `status_line` / `status_done_line` 的文本内容
- 初始 prompt 正文
- 明文历史 transcript

private mode 下，server **仍可见**：

- task / project / user / agent host 标识
- message id、请求时间、消息方向、状态变化
- ciphertext blob 与大致长度
- backend 类型、任务是否运行中、是否完成
- 明确标记为 public 的 task title / daemon name / backend name

换言之，本 RFC 目标是“内容私密”，不是“流量与元数据完全匿名”。

### 4. 密钥模型

#### 4.1 Execution host 设备身份密钥

每个能够执行 private task 的 **execution host** 都生成并持久化一组 stable device key。

这里的 execution host 包括：

- daemon 管理的 agent 主机
- 直接运行 `conductor fire` 的 manual fire 主机

建议：

- 推荐算法：`X25519`（密钥交换）
- 私钥保存在本机，例如 `~/.conductor/keys/private-mode-device.key`
- 同一台机器上的 daemon 与 direct `conductor-fire` 可以共用这组 stable host key
- 公钥在 agent / fire host 建连时上报给 server，仅用于 key envelope 转发

server 不保存私钥，不具备解密能力。

因此 v1 的结论调整为：

- server 侧识别的是 **execution host device identity**，而不是仅 daemon identity
- private task 可以绑定到 daemon-managed execution host，也可以绑定到 direct-fire execution host

#### 4.2 解密边界：daemon-managed 与 direct-fire 两种执行路径

private mode 的密钥模型需要同时适配两种执行拓扑：

1. **daemon-managed task**
   - task 绑定到 daemon 管理的 execution host
   - daemon 负责解封 `task_key_envelope`
   - daemon 在本机把 `TCK` 交给对应 task 的 `conductor-fire`
   - fire 负责对实际消息正文做解密/加密

2. **direct-fire task**
   - task 直接绑定到 manual `conductor-fire` host
   - `conductor-fire` 自己负责解封 `task_key_envelope`
   - `conductor-fire` 自己负责消息正文的解密/加密

也就是说：

- **daemon-managed 路径**：envelope unwrap 发生在 daemon，content decrypt/encrypt 发生在 fire
- **direct-fire 路径**：envelope unwrap 与 content decrypt/encrypt 都发生在 fire

这样设计的原因是：

- fire 始终是 AI task 的实际执行者，最终把 prompt 交给 provider 的也是 fire
- 对 daemon-managed 路径，如果让 daemon 解密每条消息再转成明文给 fire，会额外引入一条本地明文消息总线，扩大泄漏面
- 对 direct-fire 路径，本地不存在额外 daemon handoff，直接由 fire 完成 envelope unwrap 更符合现有 manual fire 架构

#### 4.3 Task 级内容密钥

每个 private task 生成一个随机 `task content key`（以下简称 `TCK`）。

`TCK` 的生成者不是固定的 browser，而是 **task creator endpoint**：

- **app 发起 task**：browser 生成 `TCK`
- **manual fire 发起 task**：`conductor fire --private` 本地生成 `TCK`

统一规则如下：

- task creator endpoint 在本地生成 `TCK`
- task creator endpoint 用目标 execution host 的 public key 加密 `TCK`，得到 `task_key_envelope`
- server 只保存 envelope，不保存明文 `TCK`
- 此后该 task 下所有 message / reply ciphertext 都使用同一个 `TCK` 加密

按入口拆开：

**A. app 发起 private task**

- browser 生成 `TCK`
- browser 用目标 execution host 的 public key 生成 `task_key_envelope`
- browser 本地加密 initial prompt / 后续 user message
- 若目标是 daemon-managed host，则 daemon 解封 `TCK` 再本地交给 fire
- 若目标是 direct-fire host，则 fire 直接解封 `TCK`

**B. manual fire 发起 private task**

- `conductor fire --private` 本地生成 `TCK`
- fire 用自身 execution host public key 生成 `task_key_envelope`
- fire 本地加密 initial prompt / 后续 assistant reply / 后续 user-turn state
- server 存储的 task metadata / ciphertext envelope 结构与 app 发起路径保持一致

#### 4.4 本地密钥保留与缓存

v1 中，谁创建 private task，谁就必须在本地保留能够继续解密该 task 的 key material。

**app 发起 task**

- browser 需要把 `TCK` 保存在当前设备本地
- 以便当前设备刷新后仍能解密历史
- 推荐实现：
  - 使用 WebCrypto 生成不可导出的本地 wrapping key
  - 将 `TCK` 包装后存放到 IndexedDB

**manual fire 发起 task**

- fire / host 侧需要在本地保留可继续恢复该 private task 的 key material
- 可采用：
  - 当前进程内保留 `TCK`
  - 或依赖本机 stable host private key，重新解封 server 保存的 `task_key_envelope`
  - 如需更好的 resume 体验，可再增加本地 task-key cache

v1 明确不支持：

- 浏览器与 CLI / fire 之间自动同步 `TCK`
- 跨设备同步 `TCK`
- 浏览器侧导出/备份 private transcript key
- 浏览器侧恢复旧设备上的 private transcript

因此 v1 的可见性边界是：

- app 发起的 private task，默认只能在创建它的同一浏览器设备上回看历史
- manual fire 发起的 private task，默认只能在创建/执行它的同一 host 上继续解密
- 若要实现 “fire 创建、app 也能解密回看”，需要后续补充 multi-recipient / access-key 设计

#### 4.5 入口路径兼容矩阵

v1 对两类 private task 的兼容性定义如下：

1. **app 发起 + daemon/fire 执行**
   - 支持
2. **manual fire 发起 + same fire host 执行**
   - 支持
3. **app 发起 + direct-fire host 执行**
   - 支持；browser 只需使用该 direct-fire host 的 public key 生成 envelope
4. **manual fire 发起 + 后续 app 直接解密历史**
   - 默认不支持；需未来增加 multi-recipient / key share 机制

### 5. 消息与存储模型

#### 5.1 服务端存储

private mode 下，message 持久化改为：

- v1 明确允许 server 保存 ciphertext transcript，以保留 durable history / replay / reconnect 能力
- `messages.content` 不再保存明文正文
- 服务端仅保存固定占位符，例如 `"[private]"`
- 实际正文写入新的密文字段（建议新增专用列或 JSON blob 字段，而不是复用通用 metadata）

建议新增字段（命名可调整）：

- `messages.is_private` `BOOLEAN`
- `messages.encrypted_payload` `TEXT`
- `messages.encryption_version` `TEXT`

`encrypted_payload` 至少包含：

- `ciphertext`
- `nonce`
- `algorithm`
- `key_id` / `task_key_ref`
- 可选 `aad`

#### 5.2 Task 级密钥 envelope 存储

建议新增 task 级私密元数据结构，用于保存：

- `private_mode_enabled`
- `task_key_envelopes[]`
- `encryption_version`
- `supported_device_ids`

v1 明确只要求 **一个 execution host envelope** 即可工作。

具体表现为：

- app 发起 task：至少有一个指向目标 execution host 的 envelope
- manual fire 发起 task：至少有一个指向当前 fire host 自身的 envelope

尽管如此，schema 设计上仍建议预留以下维度，避免未来升级时破坏兼容性：

- `recipient_type`（如 `execution_host_device` / `browser_device` / `recovery_key`）
- `recipient_id`
- `envelope_version`

这样后续若要演进到：

- 多 execution target
- 同 task 多设备查看
- 浏览器换机恢复
- org / admin recovery

可以在不推翻 v1 trust model 的前提下，扩展到类似 access-key / multi-recipient 的分发模型。

#### 5.3 统一密文 envelope

v1 应尽早定义 **统一的 encrypted envelope**，而不是让 Web、Server、daemon、fire 各自演化私有格式。

建议所有 private mode 文本载荷统一使用同一类结构（字段命名可调整）：

```json
{
  "t": "encrypted",
  "v": 1,
  "alg": "A256GCM",
  "kid": "task:tck:v1",
  "nonce": "<base64>",
  "c": "<base64 ciphertext>",
  "aad": "<optional base64>"
}
```

适用范围包括：

- private task create 时的初始消息载荷
- `POST /api/tasks/[taskId]/messages` 的用户消息
- assistant 回复上行
- 历史消息读取返回

好处是：

- 降低多端 schema 漂移风险
- 让日志审计、diagnostics redaction、存储迁移更一致
- 为未来算法升级与多语言客户端互通打基础

#### 5.4 共享 wire schema / package

private mode 相关 wire contract 不应只散落在单点实现里，而应放入共享 schema 包统一维护。

建议把以下 schema 放入共享模块（可放在 `modules/conductor-sdk`，也可拆出新的 `modules/conductor-wire`）：

- `encrypted envelope`
- `task_key_envelope`
- private task create payload
- private message read/write payload
- agent capability payload（含 `private_mode_capable` 与 public key 描述）

要求：

- Web、Server、CLI、daemon、fire 使用同一份类型与校验 schema
- 所有 private payload 在入口处做 schema validation
- 变更必须按版本演进，避免“服务端先改、客户端后补”的漂移

#### 5.5 显式版本化原则

private mode v1 虽然可以先只支持一套主算法，但协议层必须从一开始就显式版本化，禁止依赖“当前默认算法”的隐式约定。

至少以下对象应带版本信息：

- message ciphertext envelope
- `task_key_envelope`
- 服务端存储的 `encrypted_payload`
- agent capability 中声明的支持算法/版本

版本化字段至少应能表达：

- payload schema version
- encryption algorithm
- key wrapping algorithm

这样做的目的是：

- 未来可平滑升级算法
- 支持历史密文继续读取
- 为后续兼容多 recipient / recovery key / attachments 做准备

### 6. 协议改造

#### 6.1 创建 task

创建 private AI task 时：

- task creator endpoint 显式传入 `metadata.privacy.ai_private_mode = true`
- 同时提交一个或多个 `task_key_envelope`
- 如果目标 agent / execution host 未声明 `private_mode_capable` 或缺少 public key，服务端直接拒绝创建

按入口拆分：

- **app 发起 task**：browser 提交 private metadata、execution host envelope、加密后的 initial message（若有）
- **manual fire 发起 task**：`conductor fire --private` 提交 private metadata、自身 host envelope、加密后的 initial message（若有）

禁止 silent fallback 到 standard mode。

此外，private mode 下 task title 采用以下策略：

- 系统不得从 prompt / initial content 自动推导标题
- 用户可以手动输入自定义标题
- 若用户未显式输入标题，则默认使用通用标题，例如 `Private Task`

#### 6.2 用户消息上行

private mode 下：

- 当前持有 `TCK` 的客户端在本地加密用户消息正文（通常是 browser，也可能是 fire / CLI）
- `POST /api/tasks/[taskId]/messages` 提交 ciphertext envelope
- server 仅做 auth、ownership 校验、落库密文、outbox 路由、realtime 通知
- server 不解析正文，不生成 message preview，不做 channel 投影正文镜像

#### 6.3 assistant 回复上行

private mode 下：

- fire / daemon 在本地得到明文回复后，用 `TCK` 加密
- `commitSdkMessage()` / `POST /api/agent/events` 只提交 ciphertext
- 服务端只保存密文并广播 “private assistant message available” 事件

#### 6.4 历史读取

`GET /api/tasks/[taskId]/messages` 返回：

- public metadata（id、role、created_at、is_private）
- ciphertext envelope
- 不返回任何明文 content

客户端收到后在本地解密并渲染。

### 7. Runtime Status 与预览降级

private mode 下，以下字段必须改为 coarse / non-content 模式：

- `reply_preview`
- `status_line`
- `status_done_line`

保留的 server-visible 状态仅限：

- `state`
- `phase`
- `reply_in_progress`
- `backend`
- `created_at`
- 可选 `token_usage_percent` / `context_usage_percent`

示例：

- 允许：`phase = replying`
- 不允许：`reply_preview = "我建议你先修改 Dockerfile..."`

### 8. 功能降级与禁用项

private mode v1 下，以下能力要么禁用，要么只能提供弱化版本：

1. **服务端搜索 / 全文检索**
   - server 不再具备 transcript 搜索能力。
2. **channel / webhook / 第三方消息同步**
   - 默认禁用将 private 内容同步到 Feishu 等外部渠道。
3. **服务端 diagnostics transcript**
   - 诊断接口不再返回 transcript 明文，只返回状态与密文存在性。
4. **任务预览 / unread 摘要 / server-side notification text**
   - 只能展示通用文案，如 `Private task received a new message`。
5. **多设备历史回看**
   - v1 默认不支持；只有本地仍持有对应 `TCK` 的 creator / execution endpoint 才能解密历史。
6. **initialContent / prefill**
   - private mode 下不应再通过普通明文字段传递；必要时改为专用加密消息路径。
7. **附件上传**
   - v1 不支持；后续如要支持，需要独立设计端到端附件加密。

### 9. 对现有模块的影响

#### 9.1 Web

需要改造：

- `CreateTaskDialog`：增加 private mode 开关与能力检查
- chat store / API client：支持发送密文消息、接收密文历史、本地解密
- settings 页面：暴露默认开关与说明
- websocket 事件处理：区分 private message 与 standard message
- 对 fire-created private task 的 UI 展示：在无本地 key 时显示占位态，而不是尝试请求明文

#### 9.2 Server

需要改造：

- task create / task messages API：接受并保存 ciphertext envelope
- agent events API：接受加密 assistant message
- realtime projector：不再假设 `content` 必有明文
- diagnostics / channel / outbox：识别 private mode 并避免明文泄漏
- agents API：暴露 `private_mode_capable` 与 public key 元数据给已认证客户端
- task create path：同时支持 app-created private task 与 fire-created private task

#### 9.3 conductor-sdk / daemon / fire

需要改造：

- agent connect：声明 `private_mode_capable` 与 device public key
- daemon-managed path：daemon 解封 `task_key_envelope` 并把 `TCK` 本地交给 fire
- direct-fire path：fire 自行解封 `task_key_envelope`
- fire：在进入 `SessionManager` / provider 执行前解密用户消息密文
- 上行回复提交：先加密再 commit
- runtime status：private mode 下去掉内容预览
- 本地密钥文件：生成、加载、轮换基础能力

### 10. 兼容性与失败策略

#### 10.1 不支持 silent downgrade

当 task 已显式要求 private mode 时，如果出现以下任一情况，应直接失败：

- 目标 agent 不支持 private mode
- 缺少 agent public key
- creator endpoint 无法创建 / 保存本地 key material
- fire / daemon 无法解封 task key
- ciphertext 写入路径不可用

原因：对于隐私功能，silent downgrade 会破坏用户 trust contract。

#### 10.2 明确错误文案

系统应返回明确错误，例如：

- `private_mode_not_supported_by_agent`
- `private_mode_task_key_unavailable`
- `private_mode_history_not_available_on_this_device`

### 11. 观测与审计

private mode 不意味着完全放弃 observability，但 observability 必须内容无关。

允许记录：

- task 是否为 private
- message count / direction / timing
- decryption success/failure
- key envelope resolve failure
- agent capability mismatch
- status phase transitions

不允许记录：

- 解密后的 prompt / reply
- 明文 preview
- runtime status 中的自由文本片段

## Risks

- **功能损失风险**：搜索、channel、摘要、跨设备历史等能力会退化，用户可能觉得“功能被阉割”。
- **密钥丢失风险**：creator endpoint 的本地 key material 丢失后，对应设备/host 可能无法继续查看旧 private transcript。
- **设备切换体验风险**：v1 不支持跨设备解密，会带来“换电脑看不到历史”的预期落差。
- **实现复杂度风险**：消息 schema、SDK、UI、本地密钥缓存、server projector 都要一起调整。
- **误泄漏风险**：只要还有一个路径保留明文（例如 reply preview、channel outbox、日志打印），就会破坏 private mode 的可信度。
- **标题/摘要旁路泄漏风险**：即使禁止 prompt-derived 标题，用户手动输入的 title 仍然可能包含敏感信息，需要在 UI 中明确提示。

## Rollout

### Phase 1：协议与能力面

- 定义 `private_mode_capable` agent capability
- 定义 task metadata / ciphertext envelope schema
- server 拒绝 unsupported private task create
- runtime status 在 private mode 下去文本化

### Phase 2：单设备 private transcript

- task creator endpoint 生成 `TCK`
- execution host 生成 stable device key
- 用户消息与 assistant 回复改为密文存储
- app-created task 可在同一浏览器设备刷新后解密历史
- fire-created task 可在同一 execution host 上继续解密历史

### Phase 3：产品化开关与限制说明

- Settings / CreateTaskDialog 接入开关
- 明确展示功能降级说明
- diagnostics / channel / notifications 做 private gating

### Phase 4：后续增强（非 v1）

- 多设备 key sync / recovery
- private attachment encryption
- private channel delivery（如有必要）
- 更细粒度的 per-project / per-task privacy policy

## Acceptance

以下条件同时满足时，本 RFC 才算完成：

- 用户可通过 `Settings` 和 `CreateTaskDialog` 显式开启或关闭 AI private mode。
- private mode 只能在 task 创建时决定，创建后不可切换。
- private task 的 prompt / reply / runtime text preview 不再以明文出现在 server DB、server logs、realtime payload、diagnostics payload 中。
- private task 的 ciphertext transcript 可由 server 持久化保存，但 server 不能解密其内容。
- server 在 private mode 下仍能完成 auth、ownership、routing、durable outbox、replay、stop/resume。
- private task 若能力不满足会显式失败，不发生 silent downgrade。
- 产品层面对 private mode 的功能损失有明确提示。
- private task 不再从 prompt / initial content 自动生成标题；未提供标题时使用通用标题。
- 加密模型同时覆盖：
  - app-created private task
  - manual `conductor fire --private` created private task
- 至少有自动化测试覆盖：
  - private task create capability check
  - fire-created private task create capability check
  - encrypted user message persistence
  - encrypted assistant message persistence
  - runtime preview redaction
  - diagnostics / channel gating
  - history decrypt on same browser device / same fire host

## Open Questions

- private mode 是否要支持“require private only”组织策略，而不仅是个人默认开关？

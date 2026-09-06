# 0037 跨 daemon 文件传输（remote cp）

## Status

Implemented

## Owner

dang217

## Date

2026-09-04

## Summary

新增 `conductor remote cp`，在本地和另一台 daemon 主机之间双向传文件（SCP 语义）。

核心判断：**控制面走 WebSocket，数据面走 HTTP**。字节不进 agent WS，只在 WS 上发一个
几百字节的控制信封；文件本身通过 Web 后端本地磁盘中转（staging + HMAC transfer token +
sha256 校验 + 原子 rename），这条链路 **task attachment 已经把 90% 建好了**，直接泛化即可。

同时把 `remote-exec` 收编为 `conductor remote exec`。仓库内没有任何调用方，
外部兼容性由 owner 判定为不需要，所以是干净改名，不留 shim。

## Context

### 现有 remote exec 链路（RFC 0034）

```
conductor remote-exec → POST /api/agents/{host}/exec → realtimeHub.sendToAgentHost
                                                          ↓ remote_exec_request (WS)
                                                       daemon: spawn(argv, {cwd, env})
                                                          ↓ remote_exec_response (WS)
                                                       waiter resolve → HTTP 200
```

关键文件：`cli/bin/conductor-remote-exec.js`、`cli/src/remote-exec-handlers.js`、
`web/src/app/api/agents/[host]/exec/{route.ts,_helpers.ts}`、
`web/src/lib/realtime/{remote-exec.ts,hub.ts}`、`cli/src/daemon.js:6303`。

### 为什么不能直接把字节塞进这条链路

1. **输出上限 64 KB**：`remote-exec-handlers.js:10` `MAX_TAIL_CHARS = 64_000`，
   base64 之后实际只剩 ~48 KB。靠 `-- base64 file` 拿文件，天花板在 48 KB。
2. **WS 发送零背压**：`agent-gateway.ts:663-666` 的 `sendEnvelope` 是
   `socket.send(JSON.stringify(envelope))`，不看 `bufferedAmount`。往共享后端的
   Node 堆里灌几十 MB，会挤掉同一进程上所有租户的实时消息。
3. **SDK 侧不支持二进制帧**：`modules/conductor-sdk/src/ws/client.ts` 的 `WsAdapter`
   构造函数里是 `ws.on('message', (data) => this.enqueue(data.toString()))`，
   二进制帧会被 stringify 成乱码。要走 WS 必须 base64（+33% 膨胀），
   且 `perMessageDeflate: false`（`ws/client.ts:542-545`）没有压缩兜底。
4. **daemon 接收循环是串行 await 的**：`ws/client.ts:244-248` 是
   `for await (const message of conn) { await this.dispatch(message) }`，
   `dispatch`（`client.ts:311-325`）还会串行 await 每个 handler。
   一个落盘的 chunk handler 会**头阻塞掉所有控制消息**——包括 `stop_task`、
   `terminal_input`——而未派发的消息堆在 `WsAdapter.queue`（`client.ts:559`）里，
   那是个**无上限数组**。这条比背压更致命。
5. **心跳只有一次机会**：client 20s ping、丢一个 pong 就断
   （`client.ts:120,264-268`），server 25s 同样一击即
   `socket.terminate()`（`agent-gateway.ts:2098-2106`）。
   大 payload 的一次同步 `JSON.stringify`/`parse` 就足以饿死 ping 循环，
   触发假性掉线。
6. **吞吐受 RTT 支配**：每个 chunk 是一次经过 `remoteExecWaiters` 的完整往返，
   并且整个传输期间占住用户 8 个并发槽之一（`remote-exec.ts:30`）。
   500ms RTT + 4MB chunk ≈ 8 MB/s 上限。
7. **离线兜底会把大 payload 写进数据库**：`agent-outbox.ts:47` 把整个信封
   作为 `payloadJson` 文本列持久化。
8. **帧上限 100 MiB 且超限是断连不是拒帧**：两端都没设 `maxPayload`
   （`agent-gateway.ts:1449`、`ws/client.ts:542-545`），ws 默认 100 MiB，
   超了直接 1009 关连接。base64 + JSON 转义后实际天花板约 70-75 MB。
   （仓库里其实知道这个旋钮——`web/src/lib/speech/gateway.ts:64` 就设了
   `maxPayload`，只是 agent 通道没设。）

### 已经建好的地基（这是本 RFC 成立的前提）

**没有任何对象存储**（无 S3/TOS/OSS/R2/Vercel Blob，`web/package.json` 与
`cli/package.json` 都没有相关依赖）。存储就是 Web 服务器本地磁盘，
封装在 `web/src/lib/tasks/task-file-storage.ts`：

| 已有件 | 位置 | 复用方式 |
| --- | --- | --- |
| 流式落盘 + sha256 + 大小计量 + 原子 rename | `task-file-storage.ts:211-275` `writeTaskAttachmentStream` | 抽成通用 blob store |
| 流式读出 | `task-file-storage.ts:277-291` `openTaskAttachmentStreamByStorageKey` | 加 `Range` 支持 |
| HMAC capability token | `web/src/lib/tasks/attachment-transfer-token.ts:12-31` | **补 `exp` 和 purpose claim** 后复用 |
| daemon 侧硬化下载器 | `modules/conductor-sdk/src/attachments/materializer.ts:176-257` | 换掉写死的 URL 模板即可 |
| 存储配置断言 | `task-file-storage.ts:56-61` `CONDUCTOR_FILE_STORAGE_{DIR,SHARED}` | 直接复用 |
| TTL 清道夫 | `web/src/lib/tasks/task-attachment-janitor.ts` | 同构照抄 |
| daemon→server 文件上传 | **不存在** | 本 RFC 唯一真正的新东西 |

`materializer.ts:176-257` 值得单独说：它已经做了 sha256 校验、`Content-Length` 断言、
流式超量拒绝、`.part` → `rename` 原子落盘、按 hash 跳过重传、
403/404/410 归类为 permanent 不再重试、统一 AbortSignal。
这就是 SCP 的 download 原语，只是被写死在 attachment 语义里。

### 硬约束

- **nginx `client_max_body_size 20m`**（`web/nginx_conf:26`）。所有上行 body 卡在 20 MB。
  顺带发现：`MAX_ATTACHMENT_BYTES = 100 MiB`（`web/src/app/api/tasks/[taskId]/attachments/route.ts:13`、
  `MessageInput.tsx:19`、`materializer.ts:9`）**在生产环境是死代码**，超过 20 MB 的附件
  会被 nginx 直接 413，代码里的 100 MB 上限根本走不到。这是一个独立于本 RFC 的现存 bug。
- **`realtimeHub` 是进程内单例**，与 remote exec 共享同一约束：单 web 实例或粘性路由。
- **daemon 在 NAT 后**，只有一条出站 WS + 出站 HTTP 能力，服务端无法主动连它。

## Goals

- 双向传单个文件，路径由调用方指定，内容 sha256 端到端校验。
- 大文件不进 Node 堆、不进 WS。
- 对不支持的 daemon 干净地 409，而不是超时挂死。
- host 可以单独关掉文件传输而保留 exec。

## Non-Goals

- rsync 式的增量同步、断点续传、逐文件进度。（递归目录已在 `-r` 中支持，
  实现是 tar 包装，见「递归目录」一节——协议本身仍然只传单个文件。）
- rsync 式增量/差分同步。
- daemon 之间直连（沿用 RFC 0034 Option C 的结论：没有寻址也没有信任关系）。
- 浏览器端的文件管理 UI。

## Options Considered

### Option A — base64 chunk 走 WS，复用 remote_exec 的 waiter 模式

- Pros：零新增 HTTP 路由、零服务端磁盘、零 DB 行、零清道夫。整体约 300 行。
- Cons：见上面「为什么不能直接塞」四条。另外 SDK 的 `WsAdapter` 要先支持二进制帧，
  否则 +33% 膨胀跑不掉。
- **适用场景**：如果只想一天内上线并且硬性限制 ≤ 8 MB，这是对的选择。作为通用能力则不是。

### Option B — HTTP blob relay，服务端磁盘中转（选定）

- Pros：字节走两条普通 HTTP 流，背压交给 TCP；复用上表全部已有件；
  天然支持断点续传和 sha256 校验；WS 只承载一个几百字节的控制信封。
- Cons：文件在 Web 服务器磁盘上落一次，单机部署有磁盘压力，需要配额 + 清道夫。

### Option C — HTTP 纯流式中转，服务端不落盘

CLI 的 `GET` 响应挂住，服务端通过 WS 叫 daemon 发起 `PUT`，把 daemon 的 request body
直接 pipe 进 CLI 的 response body。

- Pros：零磁盘、零 DB、零清道夫。
- Cons：两个请求的生命周期强耦合，必须落在同一实例；任何抖动都要从头重传，无续传；
  需要自己实现按 transferId 配对的 pass-through 流和「daemon 一直不来」的超时。
  省下来的磁盘换来的复杂度不划算。

### Option D — 复用已有的 WebRTC datachannel

daemon 已经有一条把 PTY 字节挪出 WS 的旁路（`sendDirectPtyPayload`，
`cli/src/daemon.js:5433+`，经 `pty_transport_signal`/`pty_transport_status` 协商，
依赖可选依赖 `@roamhq/wrtc`）。

- Pros：真·点对点，后端不在数据面上，无磁盘无配额。
- Cons：`@roamhq/wrtc` 是 optionalDependency，装不上的机器（正是那些
  node-pty 探测失败的机器）就没有这条路；需要 STUN/TURN 才能穿透，
  而仓库里没有 TURN 基础设施；协商失败的回退路径又绕回 WS。
  为了单文件拷贝引入 NAT 穿透栈，复杂度与收益严重不匹配。

## Proposed Design

### 协议

- WS 事件对：`remote_file_request` / `remote_file_response`
- 能力位：`remote_file`（**与 `remote_exec` 分开**）
- 关停开关：config `remote_file: false` / env `CONDUCTOR_REMOTE_FILE=0`

为什么不复用 `remote_exec` 能力位：拿到 `remote_exec` 的人本来就能
`bash -lc 'base64 file'`，所以这两个能力位**不是安全边界**。但它们是实打实的
**协商边界**——版本错配窗口期内，老 daemon 收到不认识的事件会静默丢弃，
调用方只能等到超时；独立能力位才能换来一个干净的 409（RFC 0034 Option B 的同一论证）。

### 上行（本地 → 远端）：`conductor remote cp ./a.tar ubuntu:/srv/a.tar`

```
1. CLI  POST /api/agents/{host}/files
        {direction:"up", remotePath, name, sizeBytes, sha256, mode}
        → 建 FileTransfer 行(status=staged) → {transferId}

2. CLI  PUT  /api/agents/{host}/files/{transferId}/content   [octet-stream, 流式]
        → writeTaskAttachmentStream 的泛化版：计量 + sha256 + .uploading → rename

3. CLI  POST /api/agents/{host}/files/{transferId}/deliver
        → WS remote_file_request {action:"pull", transferId, transferToken,
                                  remotePath, sha256, sizeBytes, mode}

4. daemon GET /api/agent/files/{transferId}/content
          Authorization: Bearer <agentToken>
          X-Conductor-Host: <agentHost>
          X-Conductor-Transfer-Token: <hmac>
        → 流式写 remotePath.part → 校验 sha256 → rename 原子落盘
        → WS remote_file_response {ok, bytesWritten}

5. 清道夫回收 staging 文件（复用 attachment janitor 的 TTL 语义）
```

第 4 步就是 `materializer.materializeOne` 换个 URL 模板。

### 下行（远端 → 本地）：`conductor remote cp ubuntu:/var/log/x.log ./x.log`

```
1. CLI  POST /api/agents/{host}/files  {direction:"down", remotePath}
        → 建行(status=requested)
        → WS remote_file_request {action:"push", transferId, transferToken, remotePath}

2. daemon stat(remotePath) → 超限/不存在直接 remote_file_response 报错
        PUT /api/agent/files/{transferId}/content   [同上三个鉴权头, 流式]
        → 服务端计量 + sha256 落 staging
        → WS remote_file_response {ok, sizeBytes, sha256, mode}

3. CLI  GET /api/agents/{host}/files/{transferId}     轮询到 status=ready
        GET /api/agents/{host}/files/{transferId}/content   [支持 Range]
        → 本地 .part → 校验 sha256 → rename
```

`PUT /api/agent/files/{transferId}/content` 是本 RFC 唯一真正新增的原语：
**目前 `/api/agent/*` 下没有任何接受文件字节的路由**。它用
`authenticateAgentRequest`（`web/src/lib/auth/agent-request.ts:10-31`，
Bearer + `X-Conductor-Host`）而不是 `getActiveSubscriptionUser`，
再叠加 transfer token 的 HMAC 校验。

### 关于 20 MB 上限的两条路

- **推荐（v1）**：给这两组路由单独放开 nginx 上限，单请求一次传完。
  ```nginx
  location ~ ^/api/(agents/[^/]+/files|agent/files)/ {
    client_max_body_size 512m;
    proxy_request_buffering off;   # 别把 512MB 先缓冲到 nginx 临时文件
    proxy_pass http://127.0.0.1:6152;
    ...
  }
  ```
  `nginx_conf` 就在本仓库里（`scripts/deploy-prod.sh:157-162` 会部署它），一行配置的事。
  `proxy_read_timeout` 不用动——它是两次读之间的超时，稳定推进的流不会触发。
- **备选（v2，链路不稳时再做）**：CLI/daemon 侧按 16 MB 切片，
  用标准 `Content-Range: bytes A-B/TOTAL` 顺序追加到同一个 `.uploading` 文件。
  代价是要处理乱序/重叠/续传状态，收益是无需改 ops 且天然断点续传。

先做 v1。切片协议在两侧对称，v2 可以后加而不改路由形状。

### 传输状态

**不建表。** 进程内 `Map` + 磁盘 staging（`web/src/lib/transfers/transfer-store.ts`）。

理由：`realtimeHub` 本来就是进程内单例，传输生命周期只有几分钟，全程落在同一实例上。
建表换来的只是「web 重启时传输能续上」，代价是一次 migration 和一张要维护的表。
代价大于收益。

- staging 根目录复用附件那套：`CONDUCTOR_FILE_STORAGE_DIR`（缺省 `.conductor-data`）下的 `remote-transfers/`。
- 记录 15 分钟过期；清扫器每 60s 跑一次，同时扫描目录里**没有对应记录**的孤儿文件
  （超过 1h 的删掉）—— 这正是 web 重启后会留下的东西。
- 多实例落地（RFC 0036）时再换成表，路由形状不用动。

### 限额

| 项 | 值 | 依据 |
| --- | --- | --- |
| 单文件上限 | 512 MiB（`CONDUCTOR_REMOTE_FILE_MAX_BYTES` 可调） | Web 单机磁盘压力 |
| 每用户并发传输 | 4 | 对齐 `MAX_INFLIGHT_PER_USER = 8`，字节流更重所以更紧 |
| staging TTL | 10 分钟（对齐 `taskAttachmentTtlMs`） | 同一套清道夫 |
| transfer token 有效期 | 15 分钟 | **新增 `exp` claim**，现有 attachment token 是永久有效的 |
| daemon 侧单传输超时 | 300s | attachment 是 120s，大文件要放宽 |

### 鉴权与共享 daemon

- `/api/agents/{host}/files/**` 已被 daemon-share 白名单
  `/^\/api\/agents\/[^/]+(\/.*)?$/`（`web/src/lib/daemon-share/scope.ts:52`）覆盖，
  且 `scope.ts:379-389` 已经把 `{host}` 钉在本 share 的 guestHost 上。
  `/api/agent/**` 同样已在白名单内。**`scope.ts` 不需要任何改动。**
- 因此 guest daemon 自动获得该能力。这与 `cli/src/guest-daemon.js:186-204` 的既有决定
  一致（该处已明确把 `remote_exec` 从屏蔽列表里移除，理由是「被授权方本来就有 shell」）。
- `GUEST_BLOCKED_CAPABILITIES`（`guest-daemon.js:205-210`）**不加** `remote_file`。
- 但当 `GUEST_ROOT` 存在时，对 `remotePath` 施加 `isPathInsideGuestRoot`
  （`guest-daemon.js:246-252`）。注意它是词法检查、没有 `realpath`，
  符号链接能绕过——所以定位是防误用而非安全边界，和现有注释保持一致口径。

### 路径安全

`resolveWorkspace`（`remote-exec-handlers.js:272-290`）零约束，
`materializer` 的 `cleanSegment` 则是把一切压进单层目录——两个先例互相矛盾。
本 RFC 取 exec 的口径（owner 对自己的机器不设限），但补三条最低限度的防呆：

1. `remotePath` 必须是绝对路径或 `~/` 开头，`expandHome` 后 `path.resolve`。
2. 上行时若目标是已存在的目录，则拼上 `basename(localPath)`（scp 语义）。
3. 落盘一律 `.part` → `fs.rename`，绝不原地截断——避免传一半把线上文件写坏。
4. 日志记 path 和字节数，**不记内容**，与 `daemon.js:6303-6312` 刻意不记 argv 同理
   （该日志会被 `collect_logs` 收走）。

## CLI 入口：合并为 `conductor remote <verb>`

**结论：合并，但不破坏 `remote-exec`。**

### 支持合并的理由

1. **共享面几乎是全部**：`--target` / `--config-file` / `loadCliConfig` / `callApi` /
   ssh 式退出码约定（`EXIT.CLI_ERROR = 255`）/ 能力协商的 409 文案 / target 解析。
   `conductor-remote-exec.js` 365 行里约 120 行会被逐字复制进
   `conductor-remote-cp.js`。合并强制把它抽到 `cli/src/remote/client.js`。
2. **顶层命名空间已经 12 个子命令**，且 `conductor.js:42-55` 的数组和
   `:123-183` 的 help 文案是手工同步的。再加 `remote-cp`、之后 `remote-ls`、
   `remote-cat`，是线性增长。`remote` 一个入口 + 嵌套 help 正是
   `task` / `project` / `issue`（RFC 0025）已经在用的形状。
3. **心智模型统一**：「在另一台 daemon 主机上做的事」是一个概念。
   第二个动词在第一个动词发布两个 minor 之内就来了，第三个不会太远。

### 反对理由与回应

- *ssh/scp 是分开的*——但它们分开是因为是两个 1995 年的独立二进制、两套线协议。
  在单个 CLI 内部，`kubectl exec`/`kubectl cp`、`docker exec`/`docker cp`、
  `gh` 全都是嵌套的。
- *破坏性变更*——不破坏。`conductor.js:88` 是按
  `conductor-${subcommand}.js` 文件名约定解析的，把
  `bin/conductor-remote-exec.js` 留成三行 shim 转发到共享实现，成本为零，
  存量脚本永远能跑。只是从 `:42` 的列表和 help 文案里摘掉。

### 目标形态

```
conductor remote exec  -t <daemon> [-w <path>] [-e K=V] [--timeout] [--json] -- <cmd>
conductor remote cp    [-t <daemon>] <src> <dst>      # 任一侧可写 daemon:/path
conductor remote ls    -t <daemon> <path>             # 以后
conductor remote-exec  ...                            # 永久隐藏别名
```

`cp` 用 scp 的 `daemon:path` 前缀语法判断哪边是远端，而不是用 `-t`
（`-t` 在 `cp` 里退化成默认值/覆盖项）——因为 `cp` 有两个路径，
靠 flag 表达方向必然出现 `--to-remote` 这种噪音。

`exec` 的解析器**必须继续手写**：`conductor-remote-exec.js` 用手写解析是
刻意的，yargs 的 `.strict()` 会把要透传的远端 argv 吃掉。所以
`conductor remote` 这一层不能整个交给 yargs——按第一个 token 分发到
`exec`（手写解析）或 `cp`（yargs）两套解析器。

## 改动清单（实际落地）

**cli/**
- 新增 `cli/src/remote/client.js` —— exec 与 cp 共用的 config 解析、HTTP 客户端、
  退出码约定、流式 `putStream`/`getStream`
- 新增 `cli/src/remote/exec.js` —— 原 `bin/conductor-remote-exec.js` 的实现原样搬入
- 新增 `cli/src/remote/cp.js` —— 新增
- 新增 `cli/bin/conductor-remote.js` —— verb 分发（**不用 yargs**：`exec` 要透传远端 argv）
- 删除 `cli/bin/conductor-remote-exec.js`
- 新增 `cli/src/remote-file-handlers.js` —— daemon 侧 pull/push/stat
- `cli/bin/conductor.js` —— `remote-exec` → `remote`，help 同步
- `cli/src/daemon.js` —— `getRemoteFileEnabled`、能力位广播、handler 装配、
  `remote_file_request` 分发、`shutdownDaemon` 里的 `abortAll()`
- `cli/bin/conductor-config.js` —— `remote_file` 注释行
- 测试：`conductor-remote.test.js`（原 exec 18 个 + 分发器 7 个）、
  `conductor-remote-cp.test.js`（16）、`remote-file-handlers.test.js`（24）、
  `remote-cp-roundtrip.test.js`（8，真实 CLI × 真实 daemon handler 往返）

**web/**
- 新增 `src/lib/realtime/remote-file.ts`（仿 `remote-exec.ts`，`MAX_INFLIGHT_PER_USER = 4`）
- 新增 `src/lib/transfers/transfer-store.ts`、`src/lib/transfers/transfer-token.ts`
- `src/lib/realtime/hub.ts` —— `remoteFileWaiters`，钉住 `(userId, agentHost)`，
  **已注册进 `failWaitersForAgent` 清扫数组**
- `src/lib/realtime/agent-gateway.ts` —— `remote_file_response` case + 类型联合
- `web/server.ts` —— `startTransferJanitor()` 挂在 `startTaskAttachmentJanitor()` 旁边
- 新增路由 `api/agents/[host]/files/**`、`api/agent/files/[transferId]/content`
- `web/nginx_conf` —— files 路由 `client_max_body_size 512m` + `proxy_request_buffering off`

**skills/**
- `skills/conductor/SKILL.md` + 新增 `skills/conductor/reference/remote.md`

**没做（相对原设计的删减）**
- 不建 `FileTransfer` 表（见「传输状态」）
- 不抽 `modules/conductor-sdk` 的 `blob-download.ts`：daemon handler 直接用
  plain fetch + node streams 重新实现了 `materializer.ts:176-257` 的同等严谨度
  （sha256 校验、Content-Length 断言、流式超量拒绝、`.part`→rename、
  按 hash 跳过重传、403/404/410 归类 permanent）。附件那条链路不动，
  避免为一个新功能去改一条已经在线上跑的路径。
- 不改 `attachment-transfer-token.ts`：新的 `transfer-token.ts` 带 `exp` 和 `purpose`，
  但附件那份仍然无 `exp`。存量问题留在 Open Questions。

### 递归目录（`-r`）

不加协议：CLI 打包 → 走已有的单文件传输 → 另一侧解包 → 清理。

- 目标语义对齐 scp：已存在的目录接收源目录本身，不存在的目标就成为这份拷贝。
- 远端的打包/解包通过 `sh -c` 跑，**路径一律作为 argv 位置参数传入**
  （`sh -c <script> sh "$1" "$2" "$3"`），从不拼进脚本文本，所以带
  `;` `$` 空格的目录名是惰性的。
- 解包**先落私有 staging 目录再 mv**，不能直接解到目标的父目录：
  tarball 的顶层条目是**源**的名字，父目录里可能已经有同名的无关目录，
  直接解会覆盖它、随后的 mv 还会把它搬走。这个坑在实现时踩到了，
  由 `remote-cp-roundtrip.test.js` 的两个 neighbour 测试守住。
- 远端 tar 步骤的超时**被夹在调用方的 `--timeout` 之内**——否则
  `--timeout 30s` 仍会允许打包跑十分钟，因为它走的是 `exec` 自己的 deadline。
- 代价：需要目标有 `tar` 且开着 `remote_exec`；受限的是压缩后大小；
  没有续传和逐文件进度。

### 分片续传与 1 GiB 上限

把上限从 512 MiB 提到 1 GiB，同时**不允许**单个请求变大——恰恰相反，单请求变小。

**关键认识：续传和限流是同一个机制。** 用标准 `Content-Range` 分片上传，
一次请求只承载 32 MiB，于是同时得到：

- 断点续传：失败只重传一片，不是整个文件
- 单请求时长有界，nginx 不必放到 1g（`client_max_body_size` 反而从 512m 降到 64m）
- 单请求内存/磁盘敞口有界

#### 协议

上行（CLI→后端、daemon→后端，两条路由同构）：

```
PUT /api/agents/{host}/files/{transferId}/content
PUT /api/agent/files/{transferId}/content
  Content-Range: bytes <start>-<end>/<total>     # 省略 = 整体上传，start=0
  Content-Length: <本片字节数>

200 { transferId, status, receivedBytes, complete, sha256?, sizeBytes? }
      sha256/sizeBytes 仅在 complete 时出现（对**已落盘的全部字节**计算）
409 { error, receivedBytes }                     # start 与服务端不符，客户端据此重定位
413                                              # total 或累计超限
```

客户端从自己记的 offset 乐观发起；拿到 409 就跳到 `receivedBytes` 重试。
不需要额外的状态查询路由，最差多一次往返。

下行（后端→CLI、后端→daemon，两条路由同构）：

```
GET .../content
  Range: bytes=<start>-
206 + Content-Range: bytes <start>-<end>/<total>   # 无 Range 时 200
```

两端都写 `.part`，`.part` 的当前大小就是自己的 offset —— 不需要额外状态文件。

#### 续传的范围

**一次调用内自动重试**：这是实际会发生的故障（几秒的网络抖动），
对用户完全透明，不需要记 transferId、不需要加 flag。

**跨调用续传**不做：需要 CLI 持久化 transferId、用户显式带 `--resume`，
UX 面积大而场景罕见。协议原语已经具备，需要时再加一层薄的即可。

#### 两阶段响应（大文件的必要条件）

分片解决了单个请求的大小，但没解决**整体时长**。原先 `POST /deliver` 会一直阻塞
到 daemon 把整个文件拉完，而：

- nginx 的 files location 没设 `proxy_read_timeout` → 默认 **60s** 就掐
- 后端 WS waiter **300s** 放弃

1 GiB 在任何真实链路上都远超这两个数，所以大文件**必然假失败**：字节还在传，
用户看到 504。这在 512 MiB 时就已经坏了，只是不明显。

改成 `remote exec` 已有的两阶段形状：

- 后端等 **8 秒**。小文件在这个窗口内就完成，仍走单次往返的快路径。
- 超过就返回 `status: "delivering"` / `"requested"`，HTTP 请求立刻释放。
- daemon 稍后回话时，结果**写回 transfer 记录**；客户端轮询
  `GET /files/{transferId}` 拿最终状态。
- 并发槽按**整个传输**持有（daemon 确实还在干活），而不是按 HTTP 请求。

配套把 files 路由的 `proxy_read_timeout` / `proxy_send_timeout` 设为 300s ——
它们是**两次读之间**的超时而非总时长，所以稳定推进的流不会触发，
但能容忍 daemon 在开始吐字节前的哈希与 seek。

**迟到的失败必须写回记录**，否则客户端会永远轮询一个 `delivering` 的传输。

#### 服务器稳定性

这才是提到 1 GiB 真正要解决的问题。原先只有**每用户并发数**上限，
**没有任何全局磁盘上限** —— N 个用户 × 4 并发 × 1 GiB 是无界的。

| 措施 | 值 | 说明 |
| --- | --- | --- |
| 单文件上限 | 1 GiB（`CONDUCTOR_REMOTE_FILE_MAX_BYTES`） | |
| **全局暂存总量** | 8 GiB（`CONDUCTOR_REMOTE_FILE_TOTAL_BYTES`） | 新增，超出返回 507 |
| **每用户暂存总量** | 2 GiB | 新增，一个用户吃不掉全局预算 |
| 每用户并发传输 | 4 | 不变 |
| **创建时按声明大小预留** | | 否则 10 个并发 create 会同时通过检查再一起超限 |
| **落盘前查可用空间** | 保留 2 GiB 余量 | 新增，磁盘将满时拒绝而不是写爆 |
| 单片大小 | 32 MiB | 请求时长与敞口的上界 |
| TTL | 15 分钟，每次活动刷新 | 不变 |
| **暂存字节计入预算的口径** | 含 `ready`（已完成未取走） | 只算「在途」会漏掉仍占盘的字节 |

`-r` 的限制作用在压缩后的 tarball 上，同样是 1 GiB。

## Risks

- **Web 磁盘压力**。512 MB × 并发用户直接落在 `/opt/conductor` 所在盘上。
  缓解：每用户并发 4、10 分钟 TTL、清道夫每 60s 扫、先上线较低的配额再放宽。
- **单实例约束**。与 remote exec 同源。多实例要么粘性路由，要么
  `CONDUCTOR_FILE_STORAGE_SHARED=true` 共享挂载（断言已经在
  `task-file-storage.ts:56-61`）。RFC 0036 落地后重新评估。
- **transfer token 无 exp（存量问题）**。现有 attachment token 是永久有效的
  （`attachment-transfer-token.ts` 无 `exp` claim）。本 RFC 顺手补上，
  存量 attachment 需要一个兼容窗口。
- **符号链接绕过**。仓库里所有路径围栏（`guest-daemon.js:246-252`、
  `daemon.js:561-575`、`project-settings-yaml.ts:59-73`）都是词法比较，
  `cli/src` 和 `web/src/lib` 里没有任何 `realpath`。写入路径下的软链能逃逸。
  与现状一致，不在本 RFC 修，但要在文档里写明「这不是安全边界」。
- **传输中断留半个文件**。`.part` + 原子 rename 已覆盖远端；本地侧同样处理。

## Rollout

- 纯增量。新表 + 新路由 + 新能力位，不改任何现有语义。
- 老 daemon：后端查 `remote_file` 能力位，返回 409 + 升级提示，不会挂死。
- 老后端 + 新 daemon：广播一个没人问的能力位，无影响。
- `conductor remote-exec` **改名为** `conductor remote exec`，不保留别名。
  行为逐字不变（同一份实现搬进 `cli/src/remote/exec.js`），原有 18 个测试原样通过。
- **需要 ops 动作**：部署新 `nginx_conf`（`scripts/deploy-prod.sh` 已自动化）。
  这一条要在 PR 里显式标出。

## Acceptance

- `conductor remote cp ./a.bin ubuntu:/tmp/a.bin` 与反向都能传成，两端 sha256 一致。
- 目标已存在同名同 hash 文件时跳过重传。
- 传输中 daemon 掉线 → 明确报错，不是超时；远端不留半个文件。
- 不支持 `remote_file` 的 daemon 返回 409，不是超时。
- `remote_file: false` 的 daemon 立即拒绝。
- 超过配额返回 429；超过大小上限返回 413。
- staging 文件在 TTL 后被清道夫回收。
- 覆盖：daemon handler 测试、CLI 测试（`node:test` + 注入 fetch/fs，
  仿 `cli/test/conductor-remote-exec.test.js`）、API route 测试、hub waiter 测试，
  外加一次真实 daemon 的端到端大文件传输。

## Open Questions

- 审查发现的一类系统性问题：**客户端的条件式校验会静默降级**。
  `if (created.sha256 && digest !== created.sha256)` 在后端不返回该字段时
  直接跳过，一个损坏的下载会被 rename 到位并返回 exit 0。已改成强制要求。
  值得排查仓库里其它 `if (x && check(x))` 形状的校验。

- 512 MB 是不是太乐观？先按 128 MB 上线观察磁盘水位更稳妥？
- 要不要顺手把 `remote_exec` 也接进 `FileTransfer` 式的服务端审计记录，
  一并关掉 RFC 0034 的那个 open question？
- 现存 bug：`MAX_ATTACHMENT_BYTES = 100 MiB` 被 nginx 的 `client_max_body_size 20m`
  截断，生产环境超过 20 MB 的附件会拿到一个 nginx 的裸 413（不是 JSON 错误）。
  是把代码上限降到 20 MB，还是把 nginx 放开到 100 MB？应该独立于本 RFC 修掉。

# Chat web runtime

ChatGPT、DeepSeek、Kimi、Claude 网页聊天的本地运行时。第一版使用 Chromium/Playwright，每个 chat 独占一个 Node worker、浏览器进程和持久化 profile。多个 SDK/CLI 客户端通过本地 socket 共享 daemon，同一 chat 的发送有序，不同 chat 可并行。

Kimi、Claude 适配标记为 experimental。2026-10-25 UTC 已在 macmini 使用真实 Kimi、DeepSeek 账号验证多轮、四路并行、独立取消与重启恢复；ChatGPT、Claude 仍仅有模拟站点覆盖。Moli 留作后续资源优化。

## 在 Conductor 中使用 Kimi 和 DeepSeek

使用包含本运行时的 Conductor 版本，在运行 daemon 的主机上登录：

```bash
conductor chat-web login kimi
conductor chat-web login deepseek
```

命令打开 Chromium 登录窗口，检测到登录后保存账号认证并关闭窗口；超时会明确失败。自定义配置使用 --config-file PATH，命令会读取配置 envs 中的 CHAT_WEB_* 与代理设置，终端显式环境变量优先。登录与 daemon 应使用同一操作系统用户和 CHAT_WEB_HOME。登录过期时按提示重新执行登录，再在原任务发送消息；认证失败的浏览器会释放，重试读取新的认证。

daemon 的配置需要包含这些别名。新建配置时会自动提供；已有配置补上缺少的项，重启 daemon 使配置生效：

```yaml
allow_cli_list:
  web-kimi: chat-web --model kimi
  web-deepseek: chat-web --model deepseek
```

在 Conductor 中选择 web-kimi 或 web-deepseek 创建对话；kimi 仍表示 Kimi CLI。这两个网页别名默认自动连接或启动本地隔离运行时，无需先启动 chat-web serve 或设置 socket。每个新对话从 default 账号读取认证，独立保存网页会话和 profile，草稿、当前会话选择和聊天数据库不会从登录 profile 复制。

Kimi 默认 headed，主机需有可用图形会话；DeepSeek 默认 headless。配置别名可附加 --headed / --headless，DeepSeek 还可附加 --deepthink / --no-deepthink。例如 web-deepseek: chat-web --model deepseek --no-deepthink。修改图形模式不绕过站点自身的登录或验证。

Conductor 使用 chat-web-runtime:CHAT_ID 保存稳定身份，站点会话 id 单独保存。任务关闭会释放该 chat 的浏览器，重启使用同一身份恢复原网页对话。旧版 Kimi/DeepSeek 的站点会话 id 会导入到运行时，同一账号重复导入复用同一个 chat。缺失的运行时 id 会报错，不悄悄创建空白会话。Conductor 的 /clear 通过创建新 chat 开始独立对话。

自动启动的 daemon 在无活动 turn、无固定登录窗口且十分钟没有请求后退出；CHAT_WEB_RUNTIME_IDLE_MS 可调整该空闲时间，最小一秒。已有任务在下一次发送前会自动重新连接或启动 daemon，并恢复原 chat；不会重发已提交的消息。手工运行 serve 的 daemon 不受此自动退出策略影响。旧 daemon 缺少账号引导能力时会提示升级，不会自动中断其聊天；显式执行 conductor chat-web runtime stop 后，下次对话会启动新版本。

2026-11-01 UTC 的开发验证通过实际 AI SDK 子进程和 Conductor BridgeRunner 完成 Kimi 多轮消息、双 chat 隔离、关闭后恢复，以及停止一条生成时另一条继续完成。DeepSeek 的 Conductor 路由、账号引导和协议由自动化测试覆盖；本轮真实账号登录超时，实际收发与 DeepThink 尚待重新登录后验收。此前独立运行时的真实 DeepSeek 验证见文末。

## 启动与登录

安装包和 Playwright Chromium 后：

```bash
chat-web serve --max-workers 4 --per-account-concurrency 2
```

daemon 默认在前台运行。在另一个终端创建会话并打开该会话的登录窗口：

```bash
chat-web chat create chatgpt --account personal
chat-web chat create deepseek --account personal
chat-web chat login CHAT_A
chat-web chat login CHAT_B
```

create 输出 JSON，其中 id 是稳定的本地 chat id。把 CHAT_A、CHAT_B 替换为对应 id。login 返回后浏览器仍由 daemon 持有，在窗口中手动登录；凭证和验证步骤由用户处理。每个隔离 profile 首次需要单独授权，`chat-web login kimi|deepseek` 成功后会保存 default 账号认证，新建 default chat 自动导入；其他 accountId 仍需在对应 chat 窗口中登录。不会直接复制运行中的共享 profile。

create 默认 headless。login 将该 chat 切为 headed。当前实测 Kimi 的已有登录态切换到 headless 后，发送返回 HTTP 401，切回 headed 可用；建议 Kimi 保持 headed（创建时可传 --headed），原因尚未确认，不自动重试提交。DeepSeek 已验证 headless 和 headed。确认站点支持后，需要后台模式时运行：

```bash
chat-web chat close CHAT_A
chat-web chat resume CHAT_A --headless
```

手动打开的登录窗口会保留，不会为其他 chat 回收；开始该 chat 的发送或显式 close 后才解除保留。登录窗口可以继续用于生成；不要求手动关闭它。人工关闭了窗口后可用 resume 重新打开。

## 并行发送与事件

```bash
chat-web chat send CHAT_A "比较这两种方案" --request-id job-1 --detach
chat-web chat send CHAT_B "给出独立分析" --request-id job-2 --detach
chat-web turn events TURN_A
chat-web turn events TURN_B --after 3
```

send 默认等待终态并输出 JSON，`--detach` 立即返回 turn id，`--jsonl` 连续输出事件。turn events 支持从序号 after 之后重放；断开订阅不取消生成。

```bash
chat-web turn get TURN_A
chat-web turn cancel TURN_A
chat-web chat list
chat-web chat get CHAT_A
chat-web chat close CHAT_A
chat-web runtime status
chat-web runtime stop
```

取消排队中的 turn 不会发送网页消息。取消已提交的 turn 会尝试点击该页面的 stop，并检查控件消失。未确认停止时记录 uncertain，不宣称服务端已停。close 只操作对应 chat，并阻止继续发送，直到显式 resume。

## DeepSeek DeepThink

创建时指定每轮默认值，或发送时覆盖单轮：

~~~bash
chat-web chat create deepseek --deepthink
chat-web chat send CHAT_ID "分析这个方案" --deepthink
chat-web chat send CHAT_ID "直接回答" --no-deepthink
~~~

--deepthink 开启，--no-deepthink 关闭；两者不可同时使用，仅支持 DeepSeek。发送参数优先于 chat 创建时的默认值；两者都不指定则保持该页面当前状态。单轮覆盖不修改保存的 chat 默认值，但会改变该 profile 的网页开关。SDK 对应 deepThink: true/false，支持 client.create、client.submit、RuntimeChatSession.open 和 session.send；session.send 优先于 session.open 的默认值。

运行时在发送前读取 DeepThink 控件的 aria-pressed/aria-checked，仅在状态不符时点击，并确认切换成功。控件缺失或状态无法确认时，本轮失败且不发送消息。设置随 turn 持久化，同一 requestId 更换设置会报冲突。新客户端会先检查 daemon 能力，旧版 daemon 需要重启升级。

AI SDK 的 runtime 模式可使用 chatWebProvider: "deepseek"、chatWebDeepThink: true/false；该选项不支持旧版直连模式。2026-10-26 UTC 已使用真实账号验证开启、重复开启、关闭和保持现状四轮，均确认页面实际状态及 SSE 回复。

## SDK

```ts
import { ChatRuntimeClient } from "@love-moon/chat-web";

const client = new ChatRuntimeClient(); // 连接已有 daemon
const first = await client.create({ provider: "kimi", accountId: "personal" });
const second = await client.create({ provider: "claude", accountId: "personal" });

// 首次使用：client.resume(id, { headed: true }) 打开对应页面供用户登录。
// 登录完成后可同时提交；这里的 id 对应已经授权的 chat。
const turns = await Promise.all([first, second].map((chat, index) =>
  client.submit({
    conversationId: chat.id,
    requestId: "comparison-" + index,
    input: "独立评估这个设计",
  }),
));

const results = await Promise.all(turns.map((turn) => client.wait(turn.id)));
```

`client.events(turnId, after, signal)` 是异步迭代器，事件包括 queued、starting、submitting、message_delta、message_snapshot 和终态。message_delta 追加文本，message_snapshot 替换文本；终态事件包含最终或部分文本。事件按 turnId/seq 去重。wait 自动尝试重连，稳定 requestId 可在请求确认丢失时再次查询同一次提交；同 id 不同输入或超时报 REQUEST_CONFLICT。

`RuntimeChatSession.open(provider, { socketPath, conversationId, accountId })` 提供接近旧 ChatSession 的 open/isLoggedIn/send/interruptCurrentTurn/close 接口。默认 close 只断开 SDK 会话；releaseOnClose: true 会关闭远程 chat 并释放浏览器，Conductor 的自动运行时使用此选项。显式释放也可使用 client.closeConversation。未传 socketPath 时 open 会自动确保 daemon 可用；传入 socketPath 时连接该已有 daemon。运行时会话没有原地 clear，创建新 chat 即开始独立对话。

## AI SDK 接入

```js
const session = createAiSession("chat-web", {
  chatWebRuntimeSocket: "/absolute/path/to/runtime.sock",
  chatWebProvider: "claude",
  chatWebConversationId: "已登录的本地-chat-id",
});
```

Kimi、DeepSeek 默认自动启用运行时，例如 createAiSession("chat-web", { model: "kimi" })。显式 chatWebRuntimeSocket 或 CHAT_WEB_RUNTIME_SOCKET 可连接已运行的 daemon，并使用 chatgpt、deepseek、kimi、claude。自动模式的 Conductor 身份为 chat-web-runtime:CHAT_ID，显式 socket 模式继续使用本地 chat id；站点 id 存于 providerConversationId。ChatGPT/Gemini 默认使用 QueuedChatSession；chatWebRuntime: false 可显式选择共享 profile 路径。

## 隔离与恢复

- 全局默认四个 worker，同站点同 accountId 默认同时生成两路，可在 serve 时配置。accountId 是用户给登录身份的标签，运行时不验证多个标签是否实际对应同一个账号；站点限流与配额不会因 profile 隔离而增加。
- 空闲 worker 可回收，恢复依赖已保存的站点会话 URL。已发送但没有可靠 URL 的 chat 不会在资源回收或重启后悄悄打开新会话。
- 已开始的 turn 在异常或重启后进入 uncertain；重启只重新调度从未开始的 queued turn，不重放已提交消息。
- uncertain 会阻止该 chat 后续发送，其他 chat 继续运行。打开页面核对结果后，使用 `chat-web chat resume CHAT_ID --acknowledge` 显式解除；解除不重发旧 turn。
- 回复优先从 fetch/XHR 的 SSE 或 Kimi Connect JSON 流增量解析。终态 source 字段区分 sse、connect 与 dom，DOM 文本可能丢失 Markdown 格式。DOM 降级需要新回复节点及观察到 stop 控件出现再消失；静默两秒或超时不会直接被当作完成。WebSocket、Connect 压缩帧或变化后的站点协议可能需要更新适配器。
- 本地状态目录默认 `CHAT_WEB_HOME/runtime`，CHAT_WEB_HOME 默认 ~/.chat-web。Unix 目录权限 0700，socket 与状态文件 0600，凭证保存在各 chat 的 profile。没有开放 TCP 监听端口。
- 第一版使用原子 JSON 状态快照，最多保留 256 个 chat、4096 个 turn，每次输入上限 10 万字符、输出上限 100 万字符。达到限制会明确拒绝操作；长期归档与清理接口留待后续实现。状态含输入与回复，应按本地聊天记录管理。

所有客户端命令接受 --socket PATH。daemon 接受 --runtime-dir PATH、--browser-executable PATH、--browser-channel NAME；原有 CHAT_WEB_BROWSER_EXECUTABLE、CHAT_WEB_BROWSER_CHANNEL 环境变量也有效。

## 开发与验证

```bash
cd modules/chat-web
pnpm build
pnpm test
node dist/cli.js serve
```

测试包括本地 RPC/SDK/CLI、并发与顺序、幂等、取消、断线重放、异常检查点恢复，以及独立 Chromium 进程中的四种站点模拟页面。Kimi 模拟 Connect 二进制分帧、done 后网页主动 abort、UI 延迟解除生成状态与截断流；DeepSeek 模拟 XHR SSE、负数分片下标及 BATCH 终态。真实浏览器测试在 Chromium 不可用时跳过；可设置 CHAT_WEB_TEST_BROWSER 指定测试二进制，不会自动安装或使用真实账号。

真实账号验证覆盖同一 daemon 内 Kimi 两路（headed）和 DeepSeek 两路（headless），四条生成区间共同重叠 1024 ms，四个站点会话 id 不同。各 chat 只回忆自己的标记；取消每站点的一条生成均得到 stopConfirmed=true，另一条继续完成；重启后两站点均可继续原对话。此轮联合验证 14 个 turn，其中 12 个 completed、2 个按要求 cancelled。它验证当前网页版本的基础文本路径，不代表账号配额、附件、工具调用或长时间负载已验收。凭证、原始网络数据和执行日志不进入仓库。

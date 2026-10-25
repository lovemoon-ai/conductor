# Chat web runtime

ChatGPT、DeepSeek、Kimi、Claude 网页聊天的本地运行时。第一版使用 Chromium/Playwright，每个 chat 独占一个 Node worker、浏览器进程和持久化 profile。多个 SDK/CLI 客户端通过本地 socket 共享 daemon，同一 chat 的发送有序，不同 chat 可并行。

Kimi、Claude 适配标记为 experimental。2026-10-25 UTC 已在 macmini 使用真实 Kimi、DeepSeek 账号验证多轮、四路并行、独立取消与重启恢复；ChatGPT、Claude 仍仅有模拟站点覆盖。Moli 留作后续资源优化。

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

create 输出 JSON，其中 id 是稳定的本地 chat id。把 CHAT_A、CHAT_B 替换为对应 id。login 返回后浏览器仍由 daemon 持有，在窗口中手动登录；凭证和验证步骤由用户处理。每个隔离 profile 首次需要单独授权，旧版 `chat-web login <provider>` 的共享 profile 不会自动复制到新 chat。

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

`RuntimeChatSession.open(provider, { socketPath, conversationId, accountId })` 提供接近旧 ChatSession 的 open/isLoggedIn/send/interruptCurrentTurn/close 接口。close 只断开 SDK 会话；显式释放远程 chat 使用 client.closeConversation。运行时会话没有原地 clear，创建新 chat 即开始独立对话。

## AI SDK 接入

```js
const session = createAiSession("chat-web", {
  chatWebRuntimeSocket: "/absolute/path/to/runtime.sock",
  chatWebProvider: "claude",
  chatWebConversationId: "已登录的本地-chat-id",
});
```

也可通过 CHAT_WEB_RUNTIME_SOCKET 环境变量启用。支持 chatgpt、deepseek、kimi、claude 网页 provider。runtime session id 保持本地 id，站点 id 另存在 providerConversationId；resumeSessionId 可以传入该本地 id。未设置运行时 socket 时，现有 ChatSession 路径保持可用。

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

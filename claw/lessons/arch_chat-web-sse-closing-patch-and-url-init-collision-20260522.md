# chat-web ChatGPT SSE：闭合 patch 子事件被丢 & init/prepare 抢占真正流

- Date: 2026-05-22
- Module: `modules/chat-web` (新增 `core/sse-parser.ts` + `providers/chatgpt-sse-collector.ts`)
- Surfaced by: 实现"方案 A：SSE 拦截"以保真 markdown 后，多 turn 验证测试

## 背景

`extractLastAssistantMessage` 旧实现走的是 DOM `innerText`，会把 ChatGPT 渲染后的列表 bullet、表格 `|`、代码 ` ``` ` 全部丢失（这些都是 CSS `::before` 伪元素或解析后的 HTML 节点）。

为了拿到模型的**原始 markdown**，引入 `ChatGPTSSECollector`：监听 `/backend-api/.*/conversation` 的 SSE 流，按 v1 delta 编码累积 `/message/content/parts/0`，作为首选抽取路径，DOM innerText 仅当 SSE 失败时兜底。

## 两个 bug 连环出现

### Bug 1：URL 正则太宽，被 init/prepare 抢占

旧正则 `/\/backend-api\/.*conversation(\b|$|\/)/` 同时匹配：

- `/backend-api/conversation/init` — 200 application/json
- `/backend-api/f/conversation/prepare` — 200 application/json
- `/backend-api/f/conversation` — 200 **text/event-stream**（真正的流）

三个 response 按时间顺序到达。collector 的 `pendingTurn.captured = true` 在**第一个**匹配的响应上置位，于是 `/conversation/init` 抢了 captured 位，真正的 SSE 响应被跳过，回退 innerText。

**修复**：
1. 正则要求 `conversation` 必须是路径**最末段**：
   ```ts
   /\/backend-api\/(?:[^/]+\/)*conversation(?:\?|$)/
   ```
2. 加 content-type 过滤：只吃 `text/event-stream`：
   ```ts
   if (!contentType.includes("event-stream")) return;
   ```
3. 加 regex 单元测试覆盖三种正确变体 + 三种容易误伤的兄弟 URL。

### Bug 2：闭合 `patch` 子事件被 `partMatch` 早退跳过

ChatGPT 的 v1 delta 编码把**消息的收尾 token**（包括代码块的闭合 ` ``` `、`status: finished_successfully`、`end_turn: true`、metadata 等）打包成一个**顶层 `patch` 事件**：

```jsonc
event: delta
data: {"p": "", "o": "patch", "v": [
  {"p": "/message/content/parts/0", "o": "append", "v": "```"},   ← 闭合反引号在这里
  {"p": "/message/status", "o": "replace", "v": "finished_successfully"},
  {"p": "/message/end_turn", "o": "replace", "v": true},
  {"p": "/message/metadata", "o": "append", "v": {...}}
]}
```

注意外层 wrapper 的 `p` 是 **空串**。

`applyDelta` 旧版按这个顺序：

```ts
const path = obj.p ?? lastDeltaPath;
const partMatch = path?.match(/parts\/(\d+)/);
if (!partMatch) return;         // ← 顶层 p="" 在这里被早退
...
else if (op === "patch" && Array.isArray(v)) {
  for (const sub of v) this.applyDelta(sub); // ← 永远不到这里
}
```

后果：每条带代码块的回复都丢失收尾 ` ``` `，列表/表格/普通文本可能丢失最后一段。表现就是文本"砍尾"，看起来像 stream 提前终止。

**修复**：把 patch 递归提到 `partMatch` 检查**之前**：

```ts
if (op === "patch" && Array.isArray(obj.v)) {
  for (const sub of obj.v) {
    if (sub && typeof sub === "object") this.applyDelta(sub);
  }
  return;
}

const partMatch = path?.match(/parts\/(\d+)/);
if (!partMatch) return;
…
```

并加单元测试 `processes a real-shape closing patch with empty top-level path`，body 严格仿照真实 SSE。

## 顺带发现的细节

- `response.text()` 在 SSE 流上能拿到完整 body（实测 12039 字节），但**保险起见**在读 body 之前 `await response.finished()`。这是网络层的 "request finished" 信号，等到流真正关闭。某些 Playwright 构建在 chunked transfer 上对未先 `finished()` 的 `text()` 调用会返回 handler-time 已缓冲的部分内容。
- `event: delta_encoding\ndata: "v1"` 这个协议头的 data 是裸字符串 `"v1"`，JSON.parse 成功但不是对象。`if (!parsed || typeof parsed !== "object") return;` 这一行直接吃掉，**不要**把它当事件继续处理。
- ChatGPT 一个 turn 内会先 add 一个 `content_type: "model_editable_context"` 的隐藏 assistant 消息，再 add 真正的 `content_type: "text"` 可见 assistant 消息。我们用单一 `__current` synthetic key 累积文本，恰好 OK，因为可见消息的 deltas 才显式带 `/message/content/parts/N`。

## 验证

多 turn 真实 ChatGPT 测试：

| | 旧 (innerText) | 现 (SSE + patch 修复) |
|---|---|---|
| Turn 0 代码块 | 295 字、含 "Python\nRun" UI chrome、无 ` ``` ` | **532 字**、` ```python ... ``` ` **fenceCount: 2** |
| Turn 1 编号列表 | 无 `1. 2. 3.` 前缀 | `1. … 2. … 3. …` 全在 |
| Turn 2 表格 | 无 `\|` 无分隔行 | 完整 `\|---\|---\|` + 全部数据行 |

测试套件：58/58 passing。

## 如何下次避免

1. **拦 SSE 别按 URL 模糊匹配；要按 path 末段 + content-type 双重确认**。同一 path family 下"sibling preflight endpoints"（`/init`、`/prepare`、`/finalize`、`/handshake`）几乎一定存在，且时间上**早于**真正的流，会抢占任何 first-match 状态。

2. **任何"first-match capture"机制都要先想清楚"first 是谁"**。比 `pendingTurn.captured = true` 这种状态机更稳的是**多过滤器叠加**，过滤完只剩一个候选。

3. **delta 编码协议要先把递归 op 放在最前**。`patch`、`merge`、`apply` 这类容器 op 的外层 `p`/`path` 经常为空，**先递归子事件**是规则，**早退检查容器的 path** 是反规则。这条经验在 OAI / Anthropic / DeepSeek 的 streaming 都通用。

4. **写"真实 shape" 的单元测试，不要写"想象 shape"**。旧版 `handles patch arrays of sub-deltas` 测试用顶层 `p: "/message/content/parts/0"` 测 patch —— 这是我对协议格式的**想象**，不是 ChatGPT 实际发的。结果代码看似"已支持 patch"，实际跑真实 SSE 立刻翻车。每次写 SSE/wire-format 相关代码，先抓一份真实 body 落盘，把它作为 test fixture。

5. **streaming response 读 body 的时候，先 `await response.finished()` 再 `text()`**。即使 docs 说 `text()` 会等 body 完整，对 chunked transfer / SSE 的 Playwright 实现历史上有过 partial-return 的边缘情况，`finished()` 是显式的网络生命周期 join 点，加它没坏处。

## 相关代码

- `modules/chat-web/src/core/sse-parser.ts`（纯 SSE 文本切片，无 Playwright 依赖）
- `modules/chat-web/src/providers/chatgpt-sse-collector.ts`
- `modules/chat-web/src/providers/chatgpt.ts`（`open()` 装 collector、`sendMessage()` 开 turn、`waitForResponse()` 用 SSE 主信号、`extractLastAssistantMessage()` SSE 优先 + innerText 兜底）
- `modules/chat-web/tests/sse-parser.test.ts`
- `modules/chat-web/tests/chatgpt-sse-collector.test.ts`

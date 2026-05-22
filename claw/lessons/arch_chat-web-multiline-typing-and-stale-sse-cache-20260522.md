# chat-web 多行 prompt 被拆成 N 条 + SSE collector 跨 turn 缓存泄漏

- Date: 2026-05-22
- Module: `modules/chat-web`
- Surfaced by: 任务 `09b34cf4-4594-4191-aa45-a3db8f4f9546`，用户发了一条 7 行的 arXiv 论文讨论 prompt

## 症状

用户发送：

```
我想和你讨论这篇 arXiv 论文：《ATLAS: Agentic or Latent Visual Reasoning? One Word is Enough for Both》。
HTML 全文：https://arxiv.org/html/2605.15198
PDF：https://arxiv.org/pdf/2605.15198v1
arXiv 摘要页：https://arxiv.org/abs/2605.15198
作者：Ziyu Guo, Rain Liu, Xinyan Chen, Pheng-Ann Heng

需要时请基于 HTML 全文回答，不确定就说不知道，不要编实验数值或结论。
```

期望：一条完整 prompt 进 ChatGPT，拿到论文讨论。

实际：
- DB 里 message 是**完整一条**（说明 web → daemon 链路没拆）
- 但 ChatGPT 收到的是 **5–6 条** —— 第一句"我想和你讨论..."独立 submit，剩下的 5 行各自成 message
- assistant 回复变成了 `2\n\ngenuiWVu3` —— 上一轮 "1+1=2" 的残留！

## 两个 bug 叠加

### Bug 1 (主因): `page.keyboard.type(text)` 把 `\n` 字符当 Enter 按键发

ChatGPT 的 ProseMirror 和 Gemini 的 AI Studio 都把 **Enter = 提交**、**Shift+Enter = 软换行**。

`ChatGPTAdapter.sendMessage` 之前写的是：
```ts
await page.keyboard.type(message);   // ❌
```

Playwright 的 `keyboard.type` 对每个字符发 keydown+keyup —— 遇到 `\n` 就发 Enter key event。结果：

```
typing: "我想..." ↓
typing: "《ATLAS》。" ↓
type \n → ❌ Enter key event → ProseMirror submit
typing: "HTML 全文：..." ↓
type \n → ❌ Enter key event → ProseMirror submit
...
```

整条 prompt 被切成 5–6 个 fragment 连续发出去。ChatGPT 只看到第一句"我想和你讨论...《ATLAS》..."，对剩下的 fragment 各自回了简短回复。

**修复**：新文件 `src/core/keyboard.ts` 里加 `planMultilineTyping(text)` —— 把文本按 `\r?\n|\r` split，每段 `keyboard.type(segment)`，段之间 `keyboard.press("Shift+Enter")`。返回纯 `TypingAction[]` 方便单测。`typeMultiline(page, text)` 是 trivial executor。

ChatGPT + Gemini 两个 adapter 的 `sendMessage` 都换成 `typeMultiline(page, message)`。

回归测试 `tests/keyboard.test.ts` 9 个 case，含原 ATLAS 形状的 prompt 显式 assert "**任何 press 都是 Shift+Enter，永远不是裸 Enter**"。

### Bug 2 (放大效应): `ChatGPTSSECollector.getLastAssistantText()` 跨 turn 缓存

SSE collector 之前有 `lastAssistantText: string` 字段，每次 `finishPendingTurn()` 把成功的 turn 文本写进去。`getLastAssistantText()` 直接返回这个字段 —— **跨 turn 持久**。

`ChatGPTAdapter.extractLastAssistantMessage` 在 SSE fallback 路径上用它：
```ts
const sseText = collector.getLastAssistantText();
if (sseText && sseText.trim()) return sseText.trim();
```

当 Bug 1 导致 current turn 的 SSE 没拿到正常回复（分裂提交导致 captured 的是 fragment 1 的混乱 response 或干脆是空），fallback 直接返回**上一轮**的 cache。所以 ATLAS turn 拿到了"1+1=2"那轮的 `2\n\ngenuiWVu3` —— 跟 ATLAS 完全无关。

**修复**：
- `lastAssistantText` 字段删掉
- `getLastAssistantText()` 改成**抛错**（不是静默删，因为静默会让上线后存量 caller 拿到 `undefined` 继续编织 bug），错误信息明确指向 `getCurrentTurnText()`
- 新 `getCurrentTurnText()` 直接返回 `bestAssistantText()`，只读当前 turn 的 messages map —— `beginTurn()` 之后是空，必须等新 SSE 进来才有值
- adapter 的 `extractLastAssistantMessage` 用新方法

测试：原来"preserves text across turns via getLastAssistantText" 反过来锁死成 "getCurrentTurnText returns '' after beginTurn until the new turn ingests data (no stale leak)"。再加 "getLastAssistantText is removed and throws" 防止任何残留 caller 偷偷继续用。

## 如何下次避免

1. **`page.keyboard.type` 对换行的处理永远是发 Enter key event**。任何 chat composer 适配器要发用户原始 prompt 时，**严禁直接用 `keyboard.type` 喂多行字符串**。统一走 `typeMultiline` / `planMultilineTyping`。同样规则适用于 Slack、Discord、Telegram web、X (Twitter) DM 等所有 Enter-to-send 的 web composer。

2. **"上一次成功的 X" 这种持久缓存在多 turn / 多 session 系统里几乎一定会出 stale leak bug**。本次的 `lastAssistantText` 是个 textbook 案例 —— 它的"用途"看似合理（拿到最后一次成功的 assistant 文本作为兜底），但**当且仅当当前 turn 正常时它的值才正确**，而我们恰好是在当前 turn 异常时去读它，构成天然的"读到错误状态"。规则：**fallback 数据源必须和当前操作同 lifecycle**，不能拿历史状态当 fallback。

3. **删除/重命名 method 时，旧名字不要静默拆除，要 throw**。我把 `getLastAssistantText` 重命名成 `getCurrentTurnText` 并删了背后的字段。如果只是删了，下次发布如果有任何残留 JS caller（外部 plugin / 旧编译产物）调用，它会拿到 `undefined`，可能再次悄悄产生错误数据。改成 throw 一个清晰的 Error 是**显式失败**：让 caller 上线即崩，立刻发现并修。

4. **对于"会被复用、有状态、跨 turn 持久"的对象（SSE collector / browser context / cache），单元测试一定要写 reset-after-state-change 的 case**。本次新增的 "getCurrentTurnText returns '' after beginTurn until the new turn ingests data" 就是这个范式 —— 验证状态在 lifecycle 边界正确归零。

5. **写适配器的 sendMessage 时一定要测"含换行的真实 prompt"**。我之前 chat-web 的 e2e 测试都是单行 prompt ("hi" / "用一句话介绍 Gemini 模型" / "用 python 写个 fibonacci")，全都不触发 Bug 1。**生产中的 prompt 大部分是多行**（用户从 markdown 复制、贴论文摘要、多步指令），单行测试覆盖率是误导性的。`tests/keyboard.test.ts` 的 "ATLAS-shape" regression 锁死了这条 prompt 形状。

## 相关代码

- `modules/chat-web/src/core/keyboard.ts` (新)
- `modules/chat-web/src/providers/chatgpt.ts` (sendMessage / extractLastAssistantMessage)
- `modules/chat-web/src/providers/gemini.ts` (sendMessage)
- `modules/chat-web/src/providers/chatgpt-sse-collector.ts` (`lastAssistantText` 删，`getCurrentTurnText` 加，`getLastAssistantText` throw)
- `modules/chat-web/tests/keyboard.test.ts` (新)
- `modules/chat-web/tests/chatgpt-sse-collector.test.ts` (updated)

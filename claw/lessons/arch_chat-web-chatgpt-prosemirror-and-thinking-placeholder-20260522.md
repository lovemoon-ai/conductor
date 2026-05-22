# chat-web ChatGPT 适配：ProseMirror 输入框误识别 & "Thinking" 占位提前收尾

- Date: 2026-05-22
- Module: `modules/chat-web`
- Surfaced by: `node dist/cli.js ask chatgpt "解释一下 VLA 和 VLM 的区别"`
- Reporter: aagoodluck123@gmail.com (产品自测第一发命令)

## 症状

第一次跑：

```
locator.click: Timeout 30000ms exceeded.
  waiting for locator('textarea').first()
  - element is visible, enabled and stable
  - performing click action
  - <p class="placeholder" data-placeholder="Ask anything">…</p>
    from <div role="textbox" id="prompt-textarea" contenteditable="true" …>
    subtree intercepts pointer events
  - retrying click action
  - element is not visible
  …（重试 30 秒后失败）
    at ChatGPTAdapter.sendMessage (.../providers/chatgpt.js:68:21)
```

修第一处后第二次跑：

```
stdout: Thinking
```

即 CLI 把 ChatGPT 推理模型的"思考占位文本"当成最终答复返回了。

## 根因

ChatGPT 的输入框这一代 (2026-05) 实际是 ProseMirror 富文本编辑器，DOM 结构如下：

```html
<div class="wcDTda_prosemirror-parent">
  <div id="prompt-textarea" role="textbox" contenteditable="true"
       aria-label="Chat with ChatGPT" class="ProseMirror">
    <p class="placeholder" data-placeholder="Ask anything">…</p>
  </div>
  <textarea name="prompt-textarea" placeholder="Ask anything"
            class="wcDTda_fallbackTextarea"></textarea>
</div>
```

注意两点：

1. `<textarea>` 是 **fallback 层**，给无 JS / 爬虫 / 屏幕阅读器用，并不是真正的输入入口。
2. 真正的输入入口是 `<div id="prompt-textarea" contenteditable>`，其内部还有一个 `<p class="placeholder">`，几何上和 fallback textarea **完全重叠**。

我们旧的 `findInput` 命中了 fallback textarea，于是 Playwright `click()` 时发现"目标位置的最顶层元素"是 ProseMirror 内部的 placeholder `<p>`——不是 textarea 的子节点，因此判定为 **pointer event intercepted**，30s 重试后失败。

同时，`waitForResponse` 只看"文本是否 2 秒内不变化"。但 ChatGPT 推理模型的 assistant 槽位会**先**显示几秒静态的 "Thinking" / "Thought for Ns"，再开始真正回答。文本停留 2 秒 → 我们就把 "Thinking" 当成最终回复返回了。

此外还有一个次要 Bug：`chat-web doctor --snapshot` 紧跟 `provider.open(page)`（`waitUntil: domcontentloaded`）做 snapshot，但 ProseMirror 是 DCL **之后**由 JS 注入的，所以 snapshot 里**完全没有**那个 contenteditable，导致排查时只看到 fallback textarea，被误导。

## 修复

1. **`src/providers/chatgpt.ts` — findInput**：候选列表里**移除 textarea**，按强到弱依次：`#prompt-textarea[contenteditable="true"]` → `div[role="textbox"][contenteditable="true"]` → `[contenteditable="true"]`。
2. **`src/providers/chatgpt.ts` — sendMessage**：对 contenteditable 用 `click({ force: true })` + `focus()` + `page.keyboard.type(...)`。不再用 `locator.fill()`（在 contenteditable 上是 no-op）。`force: true` 是合理的：拦截 click 的 `<p class="placeholder">` 本身就在目标元素**子树内**，落点等价。
3. **`src/providers/chatgpt.ts` — findSendButton**：首选 `button#composer-submit-button`，回退到 `button[aria-label="Send prompt"]`。旧的 `data-testid="send-button"` 已被 ChatGPT 移除。
4. **`src/providers/chatgpt.ts` — waitForResponse**：按 RFC §10 的"更稳版本"重写：
   - Phase 1: 等待 stop-button 出现（流式生成开始）；
   - Phase 2: 等待 stop-button 消失，且连续 3 次采样确认（避免推理模型在 chain-of-thought → answer 切换瞬间的 debounce 抖动）；
   - Phase 3: 文本稳定性兜底，并在 `extractLastAssistantMessage` 回调里把 "Thinking" / "Thought for Ns" / "正在思考" 这类占位文本视为空，防止它被当作答复。
5. **`src/providers/chatgpt.ts` — open**：在 `goto` 之后追加一个 `waitForComposerReady`（等 `#prompt-textarea[contenteditable]` 可见），避免后续动作竞争 ProseMirror 异步初始化。
6. **`src/commands/doctor.ts`**：`provider.open()` 后等 `networkidle` 8s 再 snapshot，保证 doctor 看到的 DOM 跟 runtime 一致。
7. **`src/core/snapshot.ts`**：snapshot collector 把 `[contenteditable="true"]` / `[role="textbox"]` / `#prompt-textarea` 提到 `textarea` 前面，并加入显式 id 选择器——以后页面再变，snapshot 至少能稳定捕获真正的输入框。
8. **`src/core/locator-score.ts`**：`INPUT_HINTS` 补 `"ask anything"`、`"chat with chatgpt"`（新版 ChatGPT 的 placeholder / aria-label）。

## 验证

```
pnpm build              # tsc clean
pnpm test               # 5 files / 24 tests, all green
node dist/cli.js ask chatgpt "解释一下 VLA 和 VLM 的区别（简短作答即可）"
# → 输出真实回答（"VLM：Vision-Language Model …VLA：Vision-Language-Action …"）
```

## 如何下次避免

1. **任何 chat 类页面别信 textarea**——现代 chat 站点（ChatGPT、Claude、Gemini、DeepSeek）的真实输入框 99% 都是 contenteditable 富文本编辑器；textarea 只是 a11y / no-JS fallback。Provider adapter 默认 candidate 列表里**首选 `contenteditable` + `role=textbox`**，textarea 仅作为最末位兜底，**且**要先验证它不是 ProseMirror / Lexical / Slate 的 fallback 层（这些库会在 contenteditable 旁挂一个隐藏 textarea）。

2. **不要拿"文本稳定"当唯一的完成信号**。RFC §10 已经写明应该组合 stop-button + send-button-enabled + 文本稳定三类信号——MVP 实现里我图省事只做了第三种，碰上推理模型立刻翻车。新 provider 上线**必须**先实现 stop-button 检测，然后再叠加文本稳定。

3. **doctor 截 snapshot 前等到页面 settle**。`waitUntil: 'domcontentloaded'` 对 SPA 来说太早；要么 `networkidle`，要么显式 `waitFor` 某个关键元素。否则 snapshot 跟 ask 看到的 DOM 不一致，自己把自己骗了。

4. **Playwright 报错"subtree intercepts pointer events"几乎总是结构错误**——目标 locator 没选对，被一个语义上更精确的子元素挡住。看到这条报错先去看那条 log 里被命名的 intercepting 子元素的 outerHTML，多半 case 直接破。

5. **`force: true` 不是坏味道**——在"拦截 click 的元素是目标的子节点"这种场景下，它就是正解；强行避开会写出 brittle 的 selector wrapper。

## 相关代码

- `modules/chat-web/src/providers/chatgpt.ts`
- `modules/chat-web/src/commands/doctor.ts`
- `modules/chat-web/src/core/snapshot.ts`
- `modules/chat-web/src/core/locator-score.ts`
- RFC: `claw/rfc/0028-chat-web-implementation-plan.md` §7–10

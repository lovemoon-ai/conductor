# chat-web Gemini (AI Studio)：fill 不触发 Angular 表单 & icon ligature 当作纯文本被抽进 innerText

- Date: 2026-05-22
- Module: `modules/chat-web/src/providers/gemini.ts`
- Surfaced by: 实测 `ChatSession.open("gemini")` + `send(...)` 端到端

## 症状

第一次跑：
```
RESPONSE_TIMEOUT - Timed out after 120000ms waiting for "gemini" response.
```

`isLoggedIn` 返回 true，`findInput` 找到 textarea，但 send 完之后 120 秒拿不到响应 —— 因为 **Run 按钮根本没启用**，那条 prompt 从未提交。

第二次（修了 send 路径后）：
```
TURN 0 (length=80, ...ms)
edit
more_vert
Model 5:54 PM
error
An internal error has occurred.
content_copy
thumb_up
thumb_down
```

输出**塞满 UI chrome** —— 头部 "Model HH:MM AM/PM"、复制/点赞按钮的 Material 图标名 (`edit`、`more_vert`、`error`、`content_copy`、`thumb_up`、`thumb_down`) 都被 `innerText` 当成文字捞回来了。

## 根因

### 1. `locator.fill()` 不触发 Angular form valid

AI Studio 是 Angular Material 应用，composer 用 ReactiveForm + 一堆 directive 监听 `input` 事件来切换 Run 按钮 disabled/enabled。

Playwright 的 `locator.fill(value)` 直接通过 CDP 设置 element value，**不会**发出 Angular 期望的事件序列（`focus` → `input` → `blur`）。结果：textarea 显示出文字、`inputValue()` 返回正确值，但 Angular 表单状态仍认为是 "pristine / invalid"，Run 按钮永远 disabled。

**只有 `page.keyboard.type(...)` 才会触发真实的 keydown/keypress/input/keyup 事件序列**，Angular 看到合法 input → 改 form state → Run 按钮 enabled。

证据：
```
// 用 fill：
textarea value after fill: 用一句话介绍...     ← value set 了
Run-by-role enabled: false                  ← 但按钮 disabled

// 用 keyboard.type：
Run enabled: true                            ← 按钮启用
```

这是和 ChatGPT 的 ProseMirror 镜像反过来的故事：
- ChatGPT 的 ProseMirror：`fill()` 是 no-op（contenteditable 不能 fill）→ 必须 `keyboard.type`
- Gemini 的 Angular textarea：`fill()` 设值但没 fire Angular 期待的事件 → 必须 `keyboard.type`

不同根因、相同结论：**面对一切现代框架驱动的 chat composer，默认 `keyboard.type`，不要 `fill`**。

### 2. Run 按钮没有 aria-label

```html
<button type="submit">
  <span>Run</span>
  <span class="material-symbols-outlined">keyboard_command_key</span>
  <span class="material-symbols-outlined">keyboard_return</span>
</button>
```

我的旧 fallback 列表全部是 `button[aria-label*="Run"]` / `aria-label="Run"` / `aria-label*="Send"` —— **全部 miss**。最终命中只能靠通用兜底 `button[type="submit"]`，但实际上这个兜底在 AI Studio 多 submit 按钮的页面里会指向错误的那一个。

修复：首选 `page.getByRole("button", { name: /^Run$/i })`（Playwright 会同时按可访问名匹配，包括从可见 text 推导出来的 name），然后才是 `ms-prompt-box button[type="submit"]` 这种 scope 过的 fallback。

### 3. Material icon 字体把图标名当成纯文本输出

AI Studio 用 Material Symbols font，渲染方式是：
```html
<span class="material-symbols-outlined">edit</span>
<span class="material-symbols-outlined">more_vert</span>
<span class="material-symbols-outlined">error</span>
```

字体把字符串 `"edit"` 渲染成 ✎ 图标。但 DOM 里的 textContent / innerText **拿到的是字面 "edit"** —— 字体替换发生在渲染层，innerText 不感知。

于是 `ms-chat-turn .turn-content` 的 innerText 长这样：
```
edit
more_vert
Model 5:54 PM
error
An internal error has occurred.
content_copy
thumb_up
thumb_down
```

**修复**：写一个 `stripChromeFromTurn(text)`：
- 干掉 `^(Model|User|System)\s+\d{1,2}:\d{2}\s*(AM|PM)?$` 这种 turn header
- 干掉**单行**精确等于已知 Material icon ligature 集合的行（`edit / more_vert / error / content_copy / thumb_up / thumb_down / refresh / delete / close / expand_more / expand_less / code / play_arrow / stop / menu`）
- 保留普通段落和故意写到内容里的 `error`（只要不是单行裸字）

测试覆盖：`tests/gemini.test.ts` 7 个 case，含"single-line 'error' 是 chrome；'an error occurred' 是内容"这种边界。

## 顺带发现的细节

- AI Studio 把 Cmd/Ctrl+Enter 绑定到 Run 快捷键；当 Run 按钮（任何原因）没找到时，键盘快捷键是可靠的 fallback。
- 这个账号在测试时没配 API key（snapshot 里有 `aria="No API key selected" text="key_off"` 按钮），所以无论选什么模型，Gemini API 都返回 "An internal error has occurred."。**适配器忠实地把这个错误文本传回 SDK**，不是适配器的问题 —— 这正是好的 adapter 行为：透传服务端响应，不要替服务端做错误推测。
- 用户给的 URL 里 `model=gemini-3.5-flash` 这个模型字符串本身没问题（AI Studio 会接受任意 model query 参数），出错本质是服务端的鉴权 / 配额问题。

## 如何下次避免

1. **任何 Angular / React / Vue 驱动的 chat 输入框，默认用 `page.keyboard.type`，不要用 `locator.fill`**。fill 写 value 但不 fire framework 期待的事件，结果是"看起来已填写、按钮还是 disabled"。这个 footgun 在 ChatGPT ProseMirror 和 Gemini Angular textarea 上都踩过了，是普遍规律。

2. **没 aria-label 的提交按钮要靠 `getByRole({ name })` 主路径**，而不是 `button[aria-label*=...]`。`getByRole` 会从 visible text、`aria-labelledby`、`title`、内部 span 推导可访问名，覆盖面广得多。`button[type="submit"]` 看起来通用但在 multi-form / multi-submit 页面会 miss-target。

3. **Material Symbols / Font Awesome / icon-as-font 风格的 UI，innerText 一定会脏**。提取助手回复之前要过一遍 chrome-strip：精确匹配单行 ligature 黑名单 + turn-header 正则。**不要用模糊匹配**（"line contains 'error'"），那会误伤把 `error` 作为正常单词的内容。

4. **写 `findSendButton` 一定要做 `isEnabled` 检查再 click**。Gemini 这次的失败链路里 `findSendButton` 返回了 disabled 的 Run 按钮，click 进 30 秒重试 timeout —— 跟之前 ChatGPT 的"placeholder 拦截 click" 是同款症状，根因不同但表现一致。

5. **写适配器时第一步：先 `doctor --snapshot` 抓一份真实 DOM**。不要凭对 Material Design / Angular Material 的"经验"猜 `ms-prompt-input`、`button[aria-label="Run"]` 这种 selector —— 全部错。snapshot 看一眼，5 分钟省 30 分钟 debug。

## 相关代码

- `modules/chat-web/src/providers/gemini.ts`
- `modules/chat-web/tests/gemini.test.ts`
- 比照：`modules/chat-web/src/providers/chatgpt.ts`（同款 `keyboard.type` over `fill` 经验，根因不同但结论相同）

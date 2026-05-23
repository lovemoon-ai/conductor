# chat-web AI Studio (Gemini)：Google WAA 反爬 challenge 让自动化浏览器无法触发模型调用

- Date: 2026-05-23
- Module: `modules/chat-web/src/providers/gemini.ts`
- Surfaced by: 用户在 conductor UI 任务里 `1+1=` 永远卡在 "Thinking" 没回复

## 2026-05-23 后续更新

第二天再测，"Thinking" 永远不出回复的现象**消失**，改成 3.6s 直接拿到 `"An internal error has occurred."` + 页面显示 "No API key selected" 按钮。

**原因更可能是 AI Studio 免费层每日 quota 用完，不是 WAA 阻断**。Quota 重置后又能用。WAA 那一波（WASM challenge 重试不停、`GenerateContent` 永远不发）也是真现象，但触发场景大概是：
- 当 quota / model 状态正常时：JS 调 WAA 解 challenge → 解出 → 发 GenerateContent
- 当 quota 已超时：服务端某条路径让 WAA 进入失败循环（既不返回错误也不让 GenerateContent 发），UI 卡 Thinking

第二天测试时 quota 重置 + 但又超了一次，所以错误回到了"显式 internal error"路径，没有 WAA 循环了。

**当前 chat-web 的处理**：在 `waitForResponse` settle 之后调 `throwIfKnownUpstreamError`，匹配 `"an internal error has occurred"` → 检查页面是否有 "No API key selected" 按钮 → 抛 `PROVIDER_API_KEY_REQUIRED`（带 hint 说明 quota 或 api-key 两条解法）。没有指向 button 的时候改抛 `PROVIDER_RATE_LIMITED`。

## 症状

`https://aistudio.google.com/prompts/new_chat` 这个页面在用户日常浏览器里能用（输入 → 几秒内回复）。但 chat-web 用 Playwright（无论 headless / headed / `channel: "chrome"`）打开同一页面、登录态正常、用户消息提交成功，**模型回复永远是 "Thinking" 占位文本，永不出真回复**。

## 根因 — WAA (Web Anti-Abuse)

抓 RPC 调用看到的顺序：

```
[t=2s]  POST .../MakerSuiteService/CountTokens          → 200, OK
[t=27s] POST .../google.internal.waa.v1.Waa/Create      → 200, body = WASM challenge
[t=61s] POST .../google.internal.waa.v1.Waa/Create      → 200, body = WASM challenge (重试)
[t=67s] POST .../google.internal.waa.v1.Waa/Create      → 200, body = WASM challenge (再重试)
... GenerateContent / streamGenerateContent  从未触发
```

**WAA = Web Anti-Abuse**。Google 在 AI Studio 前面套的反爬：

1. 用户点 Run
2. AI Studio 调 `MakerSuiteService/CountTokens` 算 token 数（OK）
3. AI Studio 调 `Waa/Create` 拿一个 WASM challenge
4. 浏览器要在客户端 JS / WASM 里**解 challenge**（CPU 运算，模拟真实用户的浏览器指纹 / interaction）
5. 解出来后提交 token → 服务端给一个调 GenerateContent 的凭据
6. 然后才能调 `GenerateContent`

**Playwright 控制的浏览器（包括 channel: "chrome" 用系统真 Chrome）解不出这个 challenge** —— Google 的 WAA solver 会检测 CDP（Chrome DevTools Protocol）的存在、缺少真实 mouse-move / 鼠标轨迹、navigator.webdriver 等线索，silently fail。结果 AI Studio 的 JS 在 WAA Create 上死循环重试，模型调用永不发出。

这是 Google 故意的设计 —— AI Studio 提供免费模型 access，不挡住自动化访问会被刷爆。**没有 chat-web 代码层面的通用解法**。

## chat-web 现在能做的（已 commit）

不能让 WAA 通过，但能：

1. **检测这个状态并清晰报错**：在 `waitForResponse` timeout 时，看 page URL 还在 `/prompts/new_chat`（说明 prompt 没被 server-side 创建）+ 模型 turn 还是 "Thinking" → 抛 `ProviderAutomationBlockedError`，带上明确 hint：
   ```
   PROVIDER_AUTOMATION_BLOCKED:
   Provider "gemini" appears to be blocking automated access ...
   The model invocation request was never made — Google's anti-abuse challenge (WAA) likely blocked it.
   
   Hint: Google AI Studio runs an anti-abuse challenge (WAA) before invoking the model.
   Headless / scripted browsers routinely fail this challenge silently. Workarounds:
   (1) use chat-web's `chatgpt` provider instead — ChatGPT is far more permissive of automation
   (2) call the Gemini API directly with an API key from https://aistudio.google.com/app/apikey
   (3) try again later — the challenge sometimes passes
   ```

2. **顺便也修了 Stop button 检测**：AI Studio 的 stop button 没有 aria-label（visible text 是 `"progress_activity Stop"`），用 `getByRole("button", { name: /^Stop$/i })` + `:has-text("Stop")` 兜底。

3. **顺便也修了 Grounding 自动关闭**：开了 Grounding with Google Search 时，AI Studio 在调模型前先调 Google Search Grounding API；这条路在某些网络 / WAA 状态下也会 silently hang。`sendMessage` 入口先点掉 "Remove Grounding with Google Search" chip。（实测发现 Grounding 关掉以后 **WAA 仍然挡住**，但关掉这步至少消除一个潜在卡点。）

## 用户实际的可选项

针对真正的"我想用 chat-web 跑 Gemini"诉求，三条现实路径：

| 方案 | 工作机制 | 限制 |
|---|---|---|
| **A. 直接换 `chatgpt` provider** | ChatGPT 对自动化基本不设防（chat-web 已实测稳定 send/receive） | 用 ChatGPT 不是 Gemini |
| **B. 用 Gemini 真正的 API key 路径** | 走 `generativelanguage.googleapis.com` 的 REST API，不经过 AI Studio 网页 | 需要 API key + 不在 chat-web 的 "网页自动化" 范围内（应该用别的 ai-sdk provider 接入，比如 vertex 或 google-genai） |
| **C. 等 WAA 放行** | Google WAA 偶尔会让自动化 browser 通过（早些时候确实通过过一次：本日上午 chat-web 跑 gemini.google.com 的时候 8.9s 拿到回复） | 不可控、不可预测 |

不可行：

- ❌ 关 headless：`headless: false` 也被 WAA 挡（实测 channel: "chrome" 也挡）
- ❌ playwright-extra stealth：能绕一部分指纹，但 WAA 的 WASM solver 主要靠 runtime 行为不是 navigator 字段，stealth 帮助有限
- ❌ 自己实现 WASM solver：reverse-engineer Google 的 WAA WASM 是非凡工程量、且 Google 会持续 rotate

## 如何下次避免

1. **任何"为什么自动化访问 Google 产品比想象的难"的问题，先怀疑 WAA**。Google 系产品（Search / Maps / AI Studio / Gemini Web App / Workspace 等）**绝大部分都有 WAA 或类似的 anti-abuse 层**。它跟 TLS fingerprint 阻断（curl 通 chromium 不通）是两个不同层，WAA 是 JS 层的 challenge，再好的 TLS 转发都解不了。

2. **`channel: "chrome"` 不是万能药**。Google 自家的反爬不只看 "你是不是真 Chrome 浏览器"，更看 "你这个浏览器有没有真实交互轨迹"。CDP 连接的浏览器 == 自动化 == 默认风险。

3. **页面 UI "看起来好像在跑"≠ "真在跑"**。本次最大启示是：UI 显示 "Thinking" + Stop button visible，看起来像 model 在生成；其实**模型调用根本没发出**。下次再碰到任何 "UI 状态看起来 OK 但没结果" 的情况，**第一步永远是抓 RPC / network**，看那个关键调用（这里是 `GenerateContent` / `streamGenerateContent`）究竟有没有发出。UI 装样子谁都会，network 不会骗人。

4. **失败必须 typed + 带 hint，不要让用户对着 UI 干等**。这次的 fix 不能让 WAA 通过，但能让用户在 30 秒内拿到一个清晰的 `PROVIDER_AUTOMATION_BLOCKED` + 3 条具体可选路径，而不是 5 分钟后一个 `RESPONSE_TIMEOUT`。

5. **不要假定"用户能在浏览器用 == 自动化能用"**。这是本次走的最大弯路。用户日常浏览器跑 AI Studio 顺畅，自动化跑不通。两者用的是同一个 URL、同一个登录态、同一个账号，但**信任度不同** —— 真人用浏览器累积了 mouse-move / 真实点击 / 跨 session 持续使用等 trust signals，自动化没有。

## 相关代码

- `modules/chat-web/src/providers/gemini.ts`（disableGroundingWithGoogleSearch + 新 Stop button 检测 + looksAutomationBlocked + 抛 ProviderAutomationBlockedError）
- `modules/chat-web/src/core/errors.ts`（新增 `ProviderAutomationBlockedError`）

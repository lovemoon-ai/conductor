# chat-web Gemini：选错产品（AI Studio vs gemini.google.com 消费者版）

- Date: 2026-05-22
- Module: `modules/chat-web/src/providers/gemini.ts`
- Surfaced by: 用户多次 web-gemini 任务全部失败、回复都是 "An internal error has occurred."

## 症状

每次 `web-gemini` 任务：
1. 登录态 OK
2. 输入框找到、Run button 启用、Click 成功
3. AI Studio 返回 "An internal error has occurred." / "Failed to generate content: permission denied"

我先把它定位成 "用户没配 API key"，新增了 `PROVIDER_API_KEY_REQUIRED` typed error。这**对症**但**没治本**。

## 真正的根因

**我选错了 Gemini 产品入口**。

Google 有两个 Gemini 产品：

| 产品 | URL | 操作模型 | chat-web 适配度 |
|---|---|---|---|
| **AI Studio** | `aistudio.google.com/prompts/new_chat?model=...` | 开发者 Playground，模型调用**强制要 API key**、按 token 计费 | ❌ 错的 |
| **Gemini 消费者版** | `gemini.google.com/app` | 普通用户聊天，**Google 账号登录即用**，免费 | ✅ 对的 |

chat-web 的设计语义是"浏览器自动化消费者网页聊天产品"，对标 ChatGPT 消费者版 `chatgpt.com`。所以正确的 Gemini 对应品**永远是** `gemini.google.com`，不是 AI Studio。

之前用户提需求时给的 URL 是 `aistudio.google.com/prompts/new_chat?model=gemini-3.5-flash`。我没多想就把它当默认 `homeUrl`，结果是把开发者 Playground 装进了一个面向消费者聊天的自动化框架里 —— 类型不匹配。

## 修复

完全重写 `GeminiAdapter`，对齐 ChatGPT 适配器的思路：

| 维度 | AI Studio (旧) | gemini.google.com (新) |
|---|---|---|
| `homeUrl` | `aistudio.google.com/prompts/new_chat?model=gemini-3.5-flash` | `gemini.google.com/app` |
| Input box | `<textarea>` inside `<ms-prompt-box>` (Angular Material) | `<div role="textbox" contenteditable>` inside `<rich-textarea>` (Quill editor) |
| Send button | `<button type="submit">` text "Run"（**没 aria-label**） | `<button aria-label="Send message">` |
| Stop button | `button[aria-label*="Stop"]` | `button[aria-label="Stop response"]` |
| 回复抽取 | `ms-chat-turn .chat-turn-container.model .turn-content`（含 "Model HH:MM"、icon ligatures 等 chrome） | `<message-content>` 或 `.markdown`（**干净文本**） |
| Conversation id | 无（page URL 不变） | `/app/{conversation-id}`（16 hex 字符，跟 ChatGPT `/c/{uuid}` 同构） |
| 需要 API key | **是** | **否**（登录 Google 账号即用） |
| chrome 剥离 | 多行复杂逻辑（icon ligatures, header） | **只剥 "Gemini said" 前缀**，干净极了 |

### 端到端实测（gemini.google.com，真账号）

```
[verify] session opened, profile: ~/.chat-web/profiles/gemini
[verify] isLoggedIn: true                ← 同一 profile，免 API key
TURN 0 (8.9s, 55 字):
  text: 我是 Gemini，一个既聪明又幽默的 AI 助手，能随时为你解答疑问、提供创意，并陪你一起高效搞定各种任务。
  url : https://gemini.google.com/app/2edebc042d1b7a52   ← conversation id 自动写到 URL
  convId: 2edebc042d1b7a52
TURN 1 (跨 turn 上下文):
  text: 简单来说，我的能力点就是：集聪明与幽默于一体，主打高效解惑、创意激发和全能任务协助。
  convId: 2edebc042d1b7a52   ← 同一 conversation
  same as turn 0: true
```

完美工作。

### AI Studio 的命运

**保留 typed errors（`PROVIDER_API_KEY_REQUIRED` / `PROVIDER_PERMISSION_DENIED`）**, 因为：
1. 旧逻辑里那些错误检测代码本来就是对症的
2. 如果用户**真的想**用 AI Studio（懂操作模型、愿意配 API key），未来可以加一个 `aistudio` provider variant，那时这些 typed errors 就用得上
3. ChatGPT 也可能有类似 "API key needed" 路径（企业版？），通用一点没坏处

但 `gemini` 默认 provider 不再点向 AI Studio。

## 如何下次避免

1. **"用户给了 URL" ≠ "正确产品入口"**。当用户提"做 X 的网页自动化"时，要先理解 X 是 *公司* 还是 *具体产品*。Google 这种大厂同一品牌下经常有 2-3 个相近产品（Gemini 消费版 / AI Studio / Vertex AI），各有不同的操作语义和登录/计费模型。下次拿到 URL 后第一件事是问 / 自查：**这个 URL 是消费者面向的（cookies + 账号即用）还是开发者面向的（API key + 计费）？**

2. **"找到输入框 + 能发出去" 不等于 "选对了产品"**。这次 AI Studio 的 input/send 全找到了、流程都跑得通，但拿不到回复 —— 因为产品要 API key。**单独测 "send 是否成功" 是浅层验证；必须测 "能拿到真实模型回复" 这条端到端**。

3. **看产品的 URL pattern 能粗判它是不是"消费者版"**。消费者版通常路径短、清晰（`gemini.google.com/app`, `chatgpt.com/c/{id}`）；开发者 Playground 路径里通常有 `prompts/`, `studio/`, `playground/`, `?model=` query param 这类暗示。下次见到 `playground` / `studio` / `api` 字样的路径就要警惕。

4. **同一品牌的两套产品，DOM 结构通常**完全**不同**。AI Studio 是 Angular Material（`<ms-prompt-box>`, `<ms-chat-turn>`, `mat-mdc-...` 类），gemini.google.com 是 Quill 编辑器（`<rich-textarea>`, `.ql-editor`）+ 自定义元素（`<message-content>`, `<model-response>`）。**适配器写完不要复用** —— 重新探查 DOM。

5. **写适配器之前必跑探查脚本**。我这次先写了 `/tmp/probe-gemini-consumer.mjs` 抓 input / send / response 候选 selector 的实际值，再据此写代码 —— 比凭"对 Material Design 的经验"猜要可靠 10 倍。这是适配 chat-web 任何新 provider 的 SOP。

## 相关代码

- `modules/chat-web/src/providers/gemini.ts`（完全重写）
- `modules/chat-web/tests/gemini.test.ts`（适配新 chrome-strip 行为 + getConversationId 测试）
- `modules/chat-web/tests/provider-registry.test.ts`（home URL 期望值改成 gemini.google.com）
- `modules/ai-sdk/src/providers/chat-web-session.js`（`providerConversationUrl()` Gemini 分支改 `/app/{id}`）

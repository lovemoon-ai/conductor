# chat-web 实现方案：通过命令行自动化 ChatGPT / DeepSeek 网页交互

## 1. 目标

实现一个本地命令行工具 `chat-web`，用于自动化操作 ChatGPT、DeepSeek 这类网页聊天产品。

核心能力：

```text
命令行输入消息
  ↓
程序自动启动独立浏览器进程
  ↓
复用持久化登录态
  ↓
把消息填入网页聊天框并发送
  ↓
等待 AI 回复完成
  ↓
从网页中抽取 assistant 回复
  ↓
返回到命令行 stdout
```

这个系统不是通用 browser agent，而是“专用聊天网页自动化 runtime”。

---

## 2. 基本判断

### 2.1 不建议的方案

不建议直接使用：

- browser-use
- Stagehand agent 模式
- Lightpanda / Obscura 这类新 headless browser engine
- 纯截图 + OCR + 点击
- 连接用户日常打开的 Chrome session

原因：

1. 你的页面和动作路径是固定的，不需要让 AI 自主浏览。
2. ChatGPT / DeepSeek 是复杂现代 Web App，最稳的是 Chromium + Playwright。
3. 新 browser engine 对这类页面兼容风险较高。
4. 截图/OCR 不如 DOM / accessibility tree 稳定。
5. 连接用户日常浏览器会污染用户环境，也不利于自动化隔离。

### 2.2 推荐方案

推荐使用：

```text
Playwright + Chromium + launchPersistentContext + provider adapter
```

也就是：

```text
程序自己启动一个独立浏览器进程
但使用固定 userDataDir
从而复用 cookies / localStorage / sessionStorage / IndexedDB 等登录态
```

---

## 3. 总体架构

```text
chat-web CLI
  ↓
Command Router
  ↓
Provider Adapter
  ├── ChatGPTAdapter
  └── DeepSeekAdapter
  ↓
Browser Profile Manager
  ↓
Playwright Persistent Context
  ↓
Chromium Page
  ↓
DOM / Accessibility / Behavior Watcher
  ↓
Response Extractor
  ↓
stdout / HTTP API / MCP Tool
```

更具体：

```text
CLI command
  ↓
chat-web core
  ↓
provider-specific adapter
  ↓
browser profile manager
  ↓
page automation
  ↓
response watcher
  ↓
result formatter
```

---

## 4. 目录结构建议

```text
chat-web/
  package.json
  tsconfig.json

  src/
    cli.ts
    server.ts

    core/
      browser.ts
      profile-manager.ts
      provider.ts
      snapshot.ts
      locator-score.ts
      response-watcher.ts
      errors.ts

    providers/
      chatgpt.ts
      deepseek.ts

    commands/
      login.ts
      ask.ts
      new-chat.ts
      doctor.ts

    mcp/
      server.ts
      tools.ts

  profiles/
    chatgpt/
    deepseek/

  config/
    config.json
```

实际用户目录建议放在：

```text
~/.chat-web/
  profiles/
    chatgpt/
    deepseek/
  logs/
  config.json
  selector-cache.json
```

---

## 5. CLI 设计

### 5.1 登录

```bash
chat-web login chatgpt
chat-web login deepseek
```

行为：

```text
1. 启动 headed Chromium
2. 使用 provider 对应的 userDataDir
3. 打开目标网页
4. 用户手动登录
5. 登录态保存在 profile 目录
6. 用户关闭或命令行退出
```

### 5.2 提问

```bash
chat-web ask chatgpt "解释一下 VLA 和 VLM 的区别"
chat-web ask deepseek "写一个 ROS topic 监听 BMS 的示例"
```

行为：

```text
1. 自己新开 Chromium
2. 加载 provider profile
3. 打开目标聊天页面
4. 检查是否已登录
5. 找到输入框
6. 输入消息
7. 发送
8. 等待回复完成
9. 抽取最后一条 assistant message
10. 打印到 stdout
11. 关闭浏览器，或交给 daemon 复用
```

### 5.3 新建对话

```bash
chat-web new chatgpt
chat-web ask chatgpt --new "重新开一个对话解释 SLAM pose graph"
```

### 5.4 常驻模式

```bash
chat-web daemon
```

然后：

```bash
curl -X POST http://localhost:8765/ask \
  -H "Content-Type: application/json" \
  -d '{"provider":"chatgpt","message":"hello"}'
```

daemon 模式的价值：

```text
1. 避免每次启动 Chromium
2. 减少登录态/风控问题
3. 支持后续 MCP 接入
4. 支持多轮对话上下文保持
```

---

## 6. 核心接口设计

### 6.1 Provider Adapter

```ts
export interface ChatProvider {
  name: string;
  homeUrl: string;

  open(page: Page): Promise<void>;
  isLoggedIn(page: Page): Promise<boolean>;

  findInput(page: Page): Promise<Locator>;
  findSendButton(page: Page): Promise<Locator | null>;
  sendMessage(page: Page, message: string): Promise<void>;

  waitForResponse(page: Page, options?: WaitOptions): Promise<string>;
  extractLastAssistantMessage(page: Page): Promise<string>;

  newChat?(page: Page): Promise<void>;
}
```

### 6.2 Browser Profile Manager

```ts
export interface BrowserProfileManager {
  getProfileDir(provider: string): string;
  ensureProfile(provider: string): Promise<void>;
  clearProfile(provider: string): Promise<void>;
}
```

### 6.3 Browser Controller

```ts
export async function launchProviderBrowser(provider: string) {
  const userDataDir = profileManager.getProfileDir(provider);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const page = context.pages()[0] ?? await context.newPage();
  return { context, page };
}
```

注意：

不要用：

```ts
const browser = await chromium.launch();
const context = await browser.newContext();
```

因为 `newContext()` 默认不复用完整登录态。对于 ChatGPT / DeepSeek 这种复杂站点，优先持久化整个 `userDataDir`。

---

## 7. 页面元素解析策略

### 7.1 原则

不要做“通用网页理解”。

应该做：

```text
provider-specific selector
  +
semantic discovery
  +
behavior verification
  +
LLM repair fallback
```

也就是：

```text
静态 selector 优先
找不到时自动发现候选元素
找到后做行为验证
验证通过后缓存 selector
失败时 dump snapshot 供修复
```

---

## 8. 元素发现分层

### 8.1 输入框发现

候选元素：

```text
textarea
[contenteditable="true"]
[role="textbox"]
input[type="text"]
aria-label 包含 message / prompt / ask / 输入 / 提问
placeholder 包含 Message / Ask / 请输入 / 给 DeepSeek 发送消息
```

打分规则：

```text
Input score =
  +5 role=textbox
  +5 textarea/contenteditable
  +4 placeholder contains Message/Ask/输入
  +4 aria-label contains Message/Prompt/Ask/输入/提问
  +3 visible
  +3 editable
  +2 near bottom of viewport
  -5 inside search/settings/sidebar
  -5 hidden
  -5 disabled
```

### 8.2 发送按钮发现

候选元素：

```text
button[type=submit]
button[aria-label*="send"]
button[aria-label*="发送"]
输入框父容器附近的 button
form 内最后一个 enabled button
带 arrow / send icon 的 button
```

打分规则：

```text
Send button score =
  +5 aria-label contains send/发送
  +4 button
  +3 near input
  +3 enabled after input
  +2 contains arrow/send icon
  -5 hidden
  -5 disabled forever
```

### 8.3 assistant 消息发现

候选元素：

```text
[data-message-author-role="assistant"]
article
main 内的 message node
markdown / prose 类节点
role=list 中最后一条非用户消息
```

打分规则：

```text
Assistant message score =
  +5 data-message-author-role=assistant
  +4 inside main conversation
  +3 contains markdown/prose
  +2 appears after user message
  +2 text grows during streaming
  -5 inside sidebar/history/modal
```

---

## 9. 行为验证

核心原则：

```text
不要相信 selector。
要相信 selector 对应元素是否真的完成了行为。
```

### 9.1 输入框验证

```text
1. 找到候选输入框
2. 输入 probe 文本
3. 检查 value / innerText 是否变化
4. 检查发送按钮是否从 disabled 变 enabled
5. 清空 probe
```

### 9.2 发送按钮验证

```text
1. 输入 probe 文本
2. 找到候选发送按钮
3. 检查按钮是否 enabled
4. 检查按钮是否靠近输入框
5. 不要在真实对话里 click probe
```

### 9.3 回复区验证

```text
1. 发送真实 message
2. user message count 增加
3. assistant message count 增加
4. 最后一条 assistant 文本持续变化
5. 最终稳定
```

---

## 10. 回复完成判断

不要只用固定 sleep。

推荐组合判断：

```text
1. stop generating 按钮消失
2. send 按钮重新 enabled
3. loading / spinner / streaming class 消失
4. 最后一条 assistant 文本连续 2 秒不再变化
```

伪代码：

```ts
async function waitUntilStable(getText: () => Promise<string>) {
  let last = "";
  let stableSince = Date.now();

  while (Date.now() - stableSince < 2000) {
    const current = await getText();

    if (current !== last) {
      last = current;
      stableSince = Date.now();
    }

    await sleep(300);
  }

  return last;
}
```

更稳的版本：

```text
assistant 文本稳定
且 stop button 不存在
且 send button 可用
```

---

## 11. Lightweight Snapshot / Ref 机制

可以借鉴 Vercel agent-browser、Stagehand、Plasmate 的思路，但不要直接引入完整 agent loop。

实现一个轻量版 snapshot：

```text
chat-web snapshot
```

输出：

```text
[e1] textbox aria="Message ChatGPT" placeholder="Message ChatGPT" visible editable
[e2] button aria="Send prompt" enabled=false near=e1
[e3] button text="New chat"
[e4] region name="Conversation"
[e5] message role="assistant" text="..."
```

内部维护：

```text
ref -> locator
```

后续动作：

```text
fill(e1, message)
click(e2)
watch(e4)
extract(e5)
```

这个设计的价值：

```text
1. 降低 selector 变更带来的影响
2. 方便 debug
3. 后续可以让 LLM 只在 selector 失效时参与修复
4. 可以缓存 ref 对应的 selector path
```

---

## 12. LLM fallback 的正确用法

不要让 LLM 每次控制浏览器。

推荐让 LLM 只做 selector repair：

```text
正常路径：
  static selector
  → behavior verification
  → execute

selector 失败：
  page snapshot
  → LLM 从候选元素里选 input/send/message
  → behavior verification
  → cache selector

仍失败：
  dump snapshot + screenshot
  → 人工修 provider adapter
```

也就是：

```text
LLM 是 selector repair assistant
不是 runtime controller
```

---

## 13. Provider Adapter 示例

### 13.1 ChatGPTAdapter

```ts
export class ChatGPTAdapter implements ChatProvider {
  name = "chatgpt";
  homeUrl = "https://chatgpt.com/";

  async open(page: Page) {
    await page.goto(this.homeUrl, { waitUntil: "domcontentloaded" });
  }

  async isLoggedIn(page: Page) {
    const input = await page.locator('textarea, [contenteditable="true"], [role="textbox"]').first();
    return await input.isVisible().catch(() => false);
  }

  async findInput(page: Page) {
    const candidates = [
      page.locator('textarea[placeholder*="Message"]').first(),
      page.locator('[contenteditable="true"]').first(),
      page.locator('[role="textbox"]').first(),
      page.locator('textarea').first(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }

    throw new Error("ChatGPT input not found");
  }

  async sendMessage(page: Page, message: string) {
    const input = await this.findInput(page);
    await input.fill(message).catch(async () => {
      await input.click();
      await page.keyboard.insertText(message);
    });

    await page.keyboard.press("Enter");
  }

  async extractLastAssistantMessage(page: Page) {
    const candidates = [
      page.locator('[data-message-author-role="assistant"]').last(),
      page.locator('main article').last(),
      page.locator('.markdown, .prose').last(),
    ];

    for (const locator of candidates) {
      if (await locator.isVisible().catch(() => false)) {
        const text = await locator.innerText().catch(() => "");
        if (text.trim()) return text.trim();
      }
    }

    throw new Error("Assistant message not found");
  }

  async waitForResponse(page: Page) {
    return waitUntilStable(() => this.extractLastAssistantMessage(page));
  }
}
```

### 13.2 DeepSeekAdapter

DeepSeek 的实现保持同样接口，只替换：

```text
homeUrl
登录检测逻辑
输入框 selector
发送按钮 selector
assistant message selector
stop button selector
```

不要把 ChatGPT 和 DeepSeek 写成一坨逻辑。

---

## 14. ask 命令主流程

```ts
export async function ask(providerName: string, message: string) {
  const provider = getProvider(providerName);

  const { context, page } = await launchProviderBrowser(providerName);

  try {
    await provider.open(page);

    const loggedIn = await provider.isLoggedIn(page);
    if (!loggedIn) {
      throw new Error(
        `Provider ${providerName} is not logged in. Run: chat-web login ${providerName}`
      );
    }

    await provider.sendMessage(page, message);

    const response = await provider.waitForResponse(page, {
      timeoutMs: 120_000,
      stableMs: 2_000,
    });

    console.log(response);
  } finally {
    await context.close();
  }
}
```

---

## 15. 错误处理

建议定义几类错误：

```text
NotLoggedInError
InputNotFoundError
SendButtonNotFoundError
ResponseTimeoutError
ResponseExtractionError
ProviderRateLimitedError
ProviderCaptchaError
SelectorVerificationError
```

每类错误都要给出下一步建议：

```text
NotLoggedInError:
  Run: chat-web login chatgpt

InputNotFoundError:
  Run: chat-web doctor chatgpt --snapshot

ResponseTimeoutError:
  Try: chat-web ask chatgpt --timeout 180000 "..."
```

---

## 16. doctor / debug 工具

必须做 `doctor`，否则 selector 一变很难排查。

```bash
chat-web doctor chatgpt
chat-web doctor chatgpt --snapshot
chat-web doctor chatgpt --screenshot
```

输出：

```text
Provider: chatgpt
Profile: ~/.chat-web/profiles/chatgpt
Page URL: https://chatgpt.com/
Login: true
Input found: true
Send button found: true
Assistant messages found: 12
Stop button found: false
Last assistant length: 1024
```

保存调试文件：

```text
~/.chat-web/logs/
  2026-05-22T10-30-00-chatgpt-snapshot.json
  2026-05-22T10-30-00-chatgpt-screenshot.png
  2026-05-22T10-30-00-chatgpt-html.html
```

---

## 17. MVP 路线

### V0：单 provider、本地 CLI

目标：

```text
chat-web login chatgpt
chat-web ask chatgpt "hello"
```

范围：

```text
1. Playwright persistent profile
2. headed Chromium
3. ChatGPT adapter
4. 输入框定位
5. Enter 发送
6. 最后一条 assistant 消息抽取
7. 文本稳定判断
```

### V1：多 provider

目标：

```text
chat-web login deepseek
chat-web ask deepseek "hello"
```

新增：

```text
1. DeepSeek adapter
2. provider config
3. selector fallback
4. doctor command
```

### V2：daemon + HTTP API

目标：

```text
chat-web daemon
curl localhost:8765/ask
```

新增：

```text
1. 常驻 browser context
2. 请求队列
3. 超时控制
4. tab/session 管理
5. 本地 HTTP API
```

### V3：MCP server

目标：

```text
让 Claude Code / Codex / 自研 agent harness 调用 chat-web
```

暴露工具：

```text
chat_web.ask(provider, message)
chat_web.new_chat(provider)
chat_web.get_last_response(provider)
chat_web.snapshot(provider)
```

### V4：selector repair

新增：

```text
1. snapshot/ref 系统
2. selector scoring
3. behavior verification
4. LLM fallback repair
5. selector cache
```

---

## 18. 和 AI-native browser 的关系

可以参考它们的思想，但不建议直接把它们作为核心依赖。

### 18.1 可以借鉴

```text
Vercel agent-browser:
  compact observation + ref 操作

Stagehand:
  observe / act / extract 分层

Plasmate:
  Semantic Object Model，即把 HTML 转成更适合 agent 的语义对象

browser-use:
  browser action loop 和错误恢复经验
```

### 18.2 不建议直接使用

```text
Lightpanda / Obscura:
  适合低成本 headless web automation
  但 ChatGPT / DeepSeek 页面兼容风险较高

browser-use:
  更适合通用网页任务
  你的任务路径固定，没必要引入完整 agent loop

Stagehand agent mode:
  适合自然语言驱动浏览器
  不适合做高稳定性的固定页面适配
```

---

## 19. 关键工程注意点

### 19.1 登录态

优先持久化整个 profile：

```text
~/.chat-web/profiles/chatgpt
~/.chat-web/profiles/deepseek
```

不要只保存 cookies。

原因：

```text
ChatGPT / DeepSeek 可能依赖 cookies、localStorage、sessionStorage、IndexedDB、service worker 等多种状态。
```

### 19.2 并发

不要同一个账号并发开多个请求。

建议：

```text
同一个 provider 单队列串行
不同 provider 可以并行
```

### 19.3 风控

建议：

```text
1. headed 模式优先
2. 使用持久化 profile
3. 不做高频批量请求
4. 不模拟异常快的用户行为
5. 遇到 captcha / verify 页面直接提示人工处理
```

### 19.4 页面变更

需要：

```text
1. 多 selector fallback
2. behavior verification
3. doctor snapshot
4. selector cache
5. provider adapter 单独维护
```

---

## 20. 最终结论

这个功能最优实现层级是：

```text
Playwright + Chromium + persistent profile + provider adapter
```

不要做成：

```text
通用 browser agent
```

而应该做成：

```text
专用聊天网页自动化 runtime
```

核心模块是：

```text
1. Browser Profile Manager
2. Provider Adapter
3. Semantic Element Discovery
4. Behavior Verification
5. Response Watcher
6. CLI / Daemon / MCP 封装
```

第一版只需要做到：

```text
chat-web login chatgpt
chat-web ask chatgpt "xxx"
```

后续再加：

```text
deepseek adapter
daemon
MCP server
snapshot/ref
selector repair
```

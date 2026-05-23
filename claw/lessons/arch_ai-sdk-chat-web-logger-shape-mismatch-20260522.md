# ai-sdk × chat-web：logger 形状不兼容，turn 直接崩在 logger.debug

- Date: 2026-05-22
- Module: `modules/ai-sdk/src/providers/chat-web-session.js`
- Surfaced by: 任务 `79eef675-cdc5-40b1-8c38-e8d11b757caa` 走 `backend=web-chatgpt` (`chat-web --model chatgpt` alias)，第一句 prompt "1+1=" 直接失败

## 症状

任务卡在 `running`，messages 表里看到：

```
sdk  | web-chatgpt session started: chat-web-chatgpt-mpgu17ky
user | 1+1=
sdk  | web-chatgpt 处理失败: this.logger.debug is not a function
sdk  | web-chatgpt 处理失败: this.logger.debug is not a function   ← 第二次失败因为状态没 reset，又被错误重试一遍
```

## 根因

**两个模块对"什么是 logger"的定义不一样**：

| 模块 | logger 接口 |
|---|---|
| `@love-moon/ai-sdk` (`normalizeLogger(...)`) | `{ log(msg: string): void }` —— 单一 channel |
| `@love-moon/chat-web` (`createLogger / defaultLogger`) | `{ level, error, warn, info, debug }` —— 分级别 |

`ChatWebSession` 旧代码：

```js
this.logger = normalizeLogger(options.logger);
// ...
this.chatSession = await mod.ChatSession.open(this.chatWebProvider, {
  headless: this.headless,
  logger: this.logger,   // ← ai-sdk 形状直接灌进去
});
```

chat-web 内部在 session 生命周期里调 `logger.debug(...)`（比如 `[${provider}] turn N: ...`），但传进去的是 ai-sdk 的 `{ log }` logger，没 `.debug` → 抛 `this.logger.debug is not a function` → 整个 turn 失败。

## 修复

新增 `adaptLoggerForChatWeb(aiSdkLogger)` 适配器，把 chat-web 的 4 个 level 全部路由到 ai-sdk 的单 `log` channel，并打上 level 前缀：

```js
function adaptLoggerForChatWeb(aiSdkLogger) {
  const sinkLog = typeof aiSdkLogger?.log === "function"
    ? aiSdkLogger.log.bind(aiSdkLogger) : null;
  const at = (level) => (...args) => {
    if (!sinkLog) return;
    try {
      sinkLog(`[chat-web ${level}] ${args.map(formatLoggerArg).join(" ")}`);
    } catch { /* best effort */ }
  };
  return { level: "info", error: at("error"), warn: at("warn"),
           info: at("info"), debug: at("debug") };
}
```

`ChatSession.open` 调用处改成：

```js
this.chatSession = await mod.ChatSession.open(this.chatWebProvider, {
  headless: this.headless,
  logger: adaptLoggerForChatWeb(this.logger),   // ← 适配
});
```

回归测试：`tests/chat-web-session.test.js` 加两个 case：
- "adapts the ai-sdk logger to chat-web's logger shape (regression: logger.debug crash)" —— 验证适配后 4 个 level 都是 function 且消息能流到底层 `log` channel
- "logger adapter survives a missing log() method" —— 验证传 `{}` / 部分 logger 也不炸

## 用户侧设置（用 alias 跑 chat-web）

复盘里也记一下用户的配置 —— 这是 `chat-web` 在 CLI 多 alias 的标准用法：

```yaml
# ~/.conductor/config-dev.yaml
allow_cli_list:
  web-chatgpt: chat-web --model chatgpt
  web-gemini:  chat-web --model gemini
```

CLI 的 `inferBuiltInRuntimeBackendFromCommand` 解析 "chat-web --model ..." 时把首 token 识别为 built-in backend `chat-web`，`--model` 经 `extractModelOptionFromCommandLine` 传给 ai-sdk。所以：

- `conductor fire --backend web-chatgpt -- "..."` → ChatGPT
- `conductor fire --backend web-gemini -- "..."` → Gemini

不需要单独给 `chat-web-chatgpt` / `chat-web-gemini` 各注册一个 ai-sdk built-in；alias 复用 + `--model` 解析就够了。

## 如何下次避免

1. **跨模块传 logger 之前，先确认两边的 logger 接口**。"logger" 是个 fuzzy concept —— 同一个 monorepo 里可能并存多种形状（`{ log }` / `{ error, warn, info, debug }` / pino / winston / console-like），跨模块传必须显式适配。同等问题之前在 ChatGPT ProseMirror vs Gemini Angular 上踩过 —— 同样是"两边对同一个 API 名字的定义不一致"。

2. **集成 ai-sdk provider 时务必跑一次真实端到端 send**，不要只看单元测试通过。这次的 logger 调用路径**单元测试覆盖不到** —— 单测用的 stub `ChatSession` 没有 `.debug` 调用，但真实的 chat-web ChatSession 有。**stub 永远比真实代码"礼貌"**，所以集成测试是必须的。

3. **状态没正常 finalize 的 turn 要在数据库层 fail 掉**。这次 ChatWebSession 没在 catch 路径里 emit `turn_failed` 的终态事件（异常发生在 logger 调用而非 turn 逻辑里），导致 task 卡 `running`。下次 ChatWebSession 的 try/catch 要更宽 —— 任何同步异常都 finalize 一遍 working_status。

4. **logger adapter 不要 silent-fail**。我故意把 sinkLog 捕获 throw 但不 rethrow（best-effort），但 level prefix `[chat-web debug]` 必须出现在最终 log 里 —— 否则下游 grep / 日志聚合就丢了这条线索。回归测试用 substring assertion 锁死这点。

## 相关代码

- `modules/ai-sdk/src/providers/chat-web-session.js`
- `modules/ai-sdk/test/chat-web-session.test.js`
- `modules/ai-sdk/src/shared.js`（`normalizeLogger`，ai-sdk logger 形状的来源）
- `modules/chat-web/src/core/logger.ts`（chat-web logger 形状的来源）

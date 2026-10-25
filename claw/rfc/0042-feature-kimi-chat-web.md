# 0042 Kimi 网页聊天接入

## Status

Proposed — 页面与代码调研完成，等待讨论；尚未实现功能。

## Owner

dang217

## Date

2026-10-25

## Summary

在 `@love-moon/chat-web` 新增独立 `KimiAdapter`，通过真实 Chromium 操作
`https://www.kimi.com/`，并接入 `@love-moon/ai-sdk` 的 `chat-web` backend。
Conductor 使用 `web-kimi` 别名；现有 `kimi` 继续表示 Kimi CLI。
第一版覆盖登录持久化、文本多轮对话、新对话、回复提取、进度与诊断。

## Context

### 当前支持情况（以代码为准）

- `modules/ai-sdk/src/session-factory.js` 的 `kimi` 分支是 CLI，包括 print/wire
  会话，与 Kimi 网页不是同一条路径。
- `modules/chat-web/src/providers/index.ts` 注册 ChatGPT、DeepSeek、Gemini，
  没有 Kimi。
- `modules/ai-sdk/src/providers/chat-web-session.js` 的
  `SUPPORTED_CHAT_WEB_PROVIDERS` 只有 `chatgpt`、`gemini`。当前传入
  `chatWebProvider: "kimi"` 或 `model: "kimi"` 不会接入 Kimi；在没有其他
  可识别候选项时会静默回退到 ChatGPT。
- `cli/bin/conductor-config.js` 已有 `web-chatgpt`、`web-gemini`，缺少
  `web-kimi`；这些配置值由 Conductor 解析，不是直接执行的 chat-web CLI 命令。
- 现有架构文档存在过时描述，本方案依据上述源码判断能力。

### 页面调研与证据边界

在 macmini 的现有 Chrome 中，通过 AppleScript 读取到当前 Kimi 标签页 URL
为 `https://www.kimi.com/`，标题为
“Kimi AI with K3.1 Pro | Built for Coding & Agentic Work”。桌面截图显示英文
空白会话首页、输入区与 K3.1 Pro 入口。仅凭截图不能确定该标签页的登录状态。

该 Chrome 未开放 CDP 调试端口，且关闭了 Apple Events JavaScript 执行。
未调整这些设置、重启用户浏览器或读取其凭据；未向 Kimi 发送聊天消息。

另用 macmini 上已有的 Playwright 启动临时无登录浏览器访问同一公开首页，
在中英文环境检查 DOM、填入但不提交文本、展开模型菜单，得到以下结果。
这些 DOM 证据来自独立公开会话，不代表已验证用户当前标签页的登录态 DOM。

| 项目 | 实测结果 | 设计影响 |
| --- | --- | --- |
| 输入框 | `.chat-input-editor[contenteditable="true"][role="textbox"]`，带 `data-lexical-editor="true"` | 使用 Playwright 定位并 `fill()`，不按 textarea 实现 |
| 多行输入 | `fill("Line one\nLine two")` 后能读回两行文本 | 保留换行；发送与换行分开处理 |
| 发送控件 | `.send-button-container` 是 div，空输入带 `disabled` class，填入文本后移除 | 检查可见性和 class 后点击，不能只找 button 或检查原生 disabled 属性 |
| 新对话 | `a.new-chat-btn`，href 为 `/?chat_enter_method=new_chat` | 首选站内新对话入口，避免硬编码中英文按钮文本 |
| 未登录状态 | 有 `Log in` / `登录`、历史同步登录入口，但输入框仍存在且填字后发送控件可用 | 不能以“存在输入框/可发送”作为登录成功依据 |
| 模型入口 | 观察到 `[data-testid="model-select-trigger"]`；菜单含 K3.1 Pro、K2.8、Instant 及思考配置 | 网站模型与 SDK 的 provider 选择应使用不同概念；渲染有延迟，定位需等待 |

尚未验证：登录后账号标志、真实发送是否触发登录、助手消息与思考区 DOM、
生成中/停止/完成/错误状态、真实会话 URL、网络流格式和结束事件、
刷新后的上下文行为。不能据首页推断这些细节或写死 `/chat/{id}` 一类路径。

## Goals

- 通过 SDK 与 Conductor 正确选择 Kimi 网页，不再误选 ChatGPT。
- 保持同一会话多轮上下文；显式新对话能清除上下文。
- 正确识别本轮助手最终回复，支持代码块和多行输入。
- 超时、登录失效、限流、验证码和页面变化能得到可诊断错误。

## Non-Goals

第一版不包含附件、图片、PPT、深度研究、Swarm、插件自动化、模型菜单自动
配置、跨进程恢复会话或强保证的网站侧停止生成。网页聊天也不自动具备
Kimi CLI 的本地文件与命令执行能力。

## Options Considered

### A. 独立网页适配器（推荐）

复用 Playwright persistent profile、profile lock、ChatSession 串行队列及
AI SDK worker/event 链路，只新增 Kimi 的页面逻辑。符合现有 provider 边界，
能通过原有 login、doctor、info 入口使用。

### B. 直接调用 Kimi 私有网页接口

可能获得原始 Markdown 与明确流结束事件，但尚未观察真实请求，鉴权与
协议生命周期也不明确。暂不将私有 HTTP 客户端作为第一版的依赖。
后续可以在同一浏览器会话内被动观察响应，确定收益后再添加专用 collector。

### C. Kimi API / Kimi CLI

已有 CLI 支持；API 也是独立接入选择，但均不能替代本次要求的网页会话。

## Proposed Design

### 1. 先补齐一次真实对话观测

在 chat-web 自有的 headed profile 中由用户完成一次登录，记录登录成功的
可靠账号标志。用简短测试覆盖单轮、带上下文的第二轮、多行/代码块、
较慢的思考回复、新对话，并记录已脱敏 DOM 与网络事件样本。
如要直接研究当前用户标签页，需要先解决现有浏览器的调试访问方式。

实现前据此确定助手消息定位、完成信号和真实会话 URL；不把首页选择器外推
为完整可用方案。网络若非 SSE，也不套用 ChatGPT 的 SSE 格式。

### 2. chat-web 中新增 KimiAdapter

新增 `modules/chat-web/src/providers/kimi.ts`，独立实现 ChatProvider，
并在 `providers/index.ts` 导出和注册。继承能力通过现有公共工具组合，
不从 DeepSeekAdapter/ChatGPTAdapter 派生。

- `open`：进入 Kimi 首页，等待应用和输入区就绪。
- `isLoggedIn`：依据已验证的账号状态并排除登录提示；当前公开首页的输入框
  只能证明页面可编辑，不能证明已登录。
- `findInput` / `findSendButton`：优先使用上述实测定位，限定可见输入区；
  缺失时给出类型化错误与 doctor 提示。
- `sendMessage`：发送前建立本轮基线与观察器，填入完整文本，等待发送可用，
  点击一次发送；只在真实观测确认后才增加 Enter 兜底。提交结果不明确时
  不自动重发，防止重复消息。
- `waitForResponse`：只观察本轮新建或发生变化的助手节点/消息标识；不能
  直接读取全页最后一个 Markdown 区域，否则第二轮可能返回上一轮回复。
  思考区、用户输入、工具卡片和推荐内容不计入最终回答。
- 完成条件结合实测的生成状态终止与本轮正文稳定；思考期间暂时静止不是
  完成。可观测的流结束信号可增强判断，但网络格式须先验证。
- 不直接把 `waitUntilStable()` 当成功依据：该工具超时时会返回已有部分
  文本，且只检查文本稳定。Kimi 应保留硬 deadline；未确认完成则报超时，
  不把部分答案当成功。进度通过 `onProgress` 回传。
- DOM 提取需保留代码块等必要结构；若用 `innerText`，应明确其 Markdown
  信息损失，不能宣称与原始 Markdown 等价。根据真实样本选择 DOM 序列化
  或已验证的浏览器响应 collector。
- `newChat`：使用新对话入口并确认旧回复/会话状态已清除；
  `getConversationId` 仅在真实 URL 结构验证后实现。
- `diagnose`：沿用 ProviderDiagnostics，报告登录、输入/发送/停止控件、
  助手消息计数和当前 URL；已有 snapshot 支持用于排查选择器失效。

继续复用 `~/.chat-web/profiles/kimi`（支持 CHAT_WEB_HOME）、浏览器锁和串行
队列。用户普通 Chrome 中已登录不意味着该独立 profile 已登录，首次需要
`chat-web login kimi`。无需复制普通 Chrome 的 cookies 或整个 profile。

### 3. AI SDK 与 Conductor 入口

在 `chat-web-session.js` 增加 `kimi` provider；不改现有 `kimi` CLI backend。
显式提供但不识别的网页 provider 应报错；仅未指定时默认 ChatGPT。
需覆盖候选项优先级与既有别名，避免无效高优先级配置被低优先级配置掩盖。
拿到真实会话 ID 后再增加 `providerConversationUrl()` 的 Kimi 分支。

在 `cli/bin/conductor-config.js` 注册 `web-kimi`（runtimeBackend 为 chat-web），
扩展配置生成和 backend 解析测试。目标配置及 SDK 用法如下（尚不可用）：

```yaml
allow_cli_list:
  web-kimi: chat-web --model kimi
```

```js
const session = createAiSession("chat-web", { chatWebProvider: "kimi" });
```

这里的 `model: "kimi"` 是既有兼容入口中的网页 provider 选择，不表示站内
K3.1 Pro 等具体模型。第一版沿用 profile 中的网站默认选择，不静默切换模型。

登录/诊断沿用现有 chat-web CLI：`chat-web login kimi`、
`chat-web doctor kimi --snapshot --json`、`chat-web info kimi --live`。
本方案不新增 Web API route，也不假设 chat-web 存在 ask 子命令。

## Risks

- DOM 与网站状态可能更新：选择器集中于 KimiAdapter，保留脱敏 fixtures
  和诊断快照；失配时明确报错。
- 登录界面与可编辑输入框共存：必须用真实登录样本校验登录判据。
- 长思考与流中断：需要生成状态、硬超时、本轮边界共同判断，防止过早完成。
- 当前 ai-sdk 的 `interruptCurrentTurn()` 仅标记中断，未真正停止网页生成；
  新 provider 不能将此描述为已实现网站侧停止。真实 Stop 支持可单独扩展。
- 会话 ID/链接不等于跨进程恢复；现有 ChatWebSession 尚无网页会话重连保证。
- 网站请求是否会触发登录/人机验证及当前账号可用模型，需要真实样本验证。

## Rollout

1. 讨论第一版范围，补齐登录与真实对话样本。
2. 实现并测试 KimiAdapter、provider 注册与诊断。
3. 接入 AI SDK、配置生成及 web-kimi 别名；默认 provider 保持不变。
4. 使用持久化 profile 做真实多轮验证，再按现有流程随 chat-web / ai-sdk /
   CLI 一起发布，避免适配器与调用方版本不匹配。

## Acceptance

- chat-web 注册列表包含 kimi；未登录首页不被误判为已登录，登录后状态可持久化。
- 多行输入保持换行且仅提交一次；第二轮延迟到达时不会返回上一轮回复。
- 代码块可正确提取；长思考不提前结束，硬超时不会把部分答案作为完整成功。
- 新对话清除上下文；登录失效、限流、验证码和结构变化产生可诊断错误。
- ChatSession 串行对话、AI SDK provider 路由、working_status / assistant_message、
  已验证的会话链接、CLI 配置生成均有相应测试；真实 Kimi 多轮走通。
- 既有 chat-web providers 与 kimi CLI 的相关测试通过。
- 本次仅新增方案文档；以上为未来实现验收项，不代表已通过。

## Open Questions

- 建议第一版先完成普通文本多轮对话，附件与复杂 Agent 功能后续扩展。
- 建议先保持站内默认模型；是否需要紧接着增加显式的 Kimi 模型/思考强度配置？
- 是否要求首版即可跨进程恢复及真实停止？若要求，需要相应扩展现有公共接口。

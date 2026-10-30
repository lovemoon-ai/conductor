# Moli 多站点聊天运行时调研

基础能力调研日期为 2026-10-25。源码快照为 [26d2d182](https://github.com/lexmount/moli/tree/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b)，本地实验使用官方 [v1.1.19 macOS arm64 release](https://github.com/lexmount/moli/releases/tag/v1.1.19)。源码 main 与发布二进制分别记录，不将两者视为同一构建。

## 结论与适用范围

第一版继续使用 Chromium。2026-10-30 的 [真实 Kimi 并行负载评估](performance.md) 发现，Moli 1.1.20 有内存优势，但真实 Kimi 的增量采集和完成确认尚未通过，空闲 CPU 也更高。下文七项实验验证的是本地 fixture 的基础能力，不能替代真实站点验收。

Moli 的无常驻窗口、按需布局设计与面向 AI 的后台运行时一致，仍可作为 [RFC 0042](../../rfc/0042-chat-browser-runtime.md) 的后续可选执行引擎。真实 DeepSeek、ChatGPT、Claude 的兼容性和混合并发需要分别验证。

建议先通过独立进程接入，保留 Chromium 后端。每个 chat 使用一个 `moli serve`、专用 profile 和独立 CDP 连接；外部 AI 继续使用统一聊天协议。通过目标站点验证后，再决定是否把适配能力进一步内嵌到 Rust 宿主。

## 与需求直接相关的能力

| 需求 | 源码与实验结果 | 对设计的影响 |
| --- | --- | --- |
| 给 AI 使用且界面可选 | 独立 Rust 浏览器内核；默认跳过真实布局与绘制，按需启用视觉操作 | 无需先开发浏览器产品 UI |
| 复用现有客户端 | 提供 CDP、WebDriver Classic 和 BiDi；README 有 Playwright connectOverCDP 示例 | 可以保留现有适配器知识，迁移宿主仍需验证 Page 操作兼容性 |
| 多 chat 状态隔离 | 临时 BrowserContext 有独立存储分区；本地同源测试中 cookies、localStorage、sessionStorage 未串用 | 同站点的两个 chat 也能验证隔离 |
| 长期登录与恢复 | 默认 profile 有持久化路径；动态 createBrowserContext 明确拒绝 persistentPartitionId | 首选独立进程加独立 profile，不能假设单实例能创建多个持久化 chat 分区 |
| 增量回复 | 本地两个 fetch ReadableStream 同时逐段到达，并能通过 Runtime.addBinding 分 session 外送 | 具备增量采集基础，但仍需观察真实站点发起的请求并解析其消息协议 |
| 故障范围 | 关闭临时 context 不打断另一个；两个进程中杀掉 A，B 的模拟流继续完成 | 强故障隔离使用独立进程；同进程多 context 仅承诺状态隔离 |

架构与协议依据：[README](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/README.md)。分区依据：[browser_context.rs](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-protocol/src/domains/target/browser_context.rs)、[分区隔离测试](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-protocol/src/conn/tests/resource_runtime.rs)。

## 已有 ChatGPT 示例与缺口

仓库已有 [ChatGPT playground](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-playground/chatgpt/README.md)，包含 raw CDP、Playwright、TUI、profile 和诊断代码。这提供了可参考的端到端路径，但仍是需要验证的 demo：

- 推荐认证路径先使用 Chromium 完成登录，再导入 cookies 与 localStorage，之后由 Moli 运行聊天页。直接认证可能被登录挑战拒绝。默认认证桥调用 Xvfb，macmini 上还需调整，不能由 macOS 二进制支持推导该桥已跨平台可用。
- 回复读取保留 `live-dom` 与 `persisted-reload` 两种来源；文档记录过实时 DOM 未显示、刷新后才读到持久化回复的情况。后者不算实时链路通过，且不能仅凭这段历史描述断言当前所有运行仍有该问题。
- 源码仍包含页面输入、发送按钮和 DOM 检查；采用 Moli 并不自动消除站点适配的维护。
- 本次查看的 moli-playground 中未发现 Kimi、DeepSeek、Claude 的同类专用示例。四站点支持需要分别建设适配器，不能从 ChatGPT demo 推导。

实现依据：[认证桥](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-playground/chatgpt/chatgpt_auth_bridge.py)、[Playwright 对话实现](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-playground/chatgpt/chatgpt_playwright_core.py)。

## 流采集和进程回收边界

`Network.dataReceived` 的已查看实现只发送长度信息，不携带响应正文。`Network.eventSourceMessageReceived` 有事件正文，但不能据此假设任意 POST fetch 的 SSE 都会转换成 EventSource 事件。本地实验在页面中主动发起 fetch，再经 reader 与 binding 输出，证明基础能力；尚未证明真实聊天页原有请求可无损旁路采集。[网络事件源码](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-protocol/src/domains/network/events.rs)

`Fetch.takeResponseBodyAsStream` 也有实现，但接管流涉及页面消费语义，不能直接作为无影响的监听器。下一步优先验证页面主世界观察、适配器受控 binding，必要时增加原生数据观察入口。[Fetch 流实现](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-protocol/src/domains/fetch/body_stream.rs)

首次实验在关闭 CDP 后立即 SIGTERM，重启后 localStorage 保留而 cookie 缺失。随后改用 `Browser.close` 并等待退出，再启动同 profile，cookie 与 localStorage 均恢复。源码明确将 SIGTERM、SIGINT、SIGHUP 设置为立即 `_exit`，不执行析构和异步清理。因此常规 worker 回收需要协议关闭与持久化确认，超时才发终止信号；crash 恢复仍需单独设计。[信号处理](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-process-signal/src/lib.rs)、[Browser.close 实现](https://github.com/lexmount/moli/blob/26d2d1826dd23878cff8ab3613f2bdf8842e0f3b/moli-protocol-server/src/cdp_scheduler/instance_command.rs)

在多 chat 共享一个 Moli 进程的方案中，`Browser.close` 会关闭整个实例，不能映射成单 chat close；需要使用其 target/context 级关闭操作。独立进程模式下，实例关闭正好对应该 chat 的资源回收。

## 本地实验记录

环境为 macmini、Darwin arm64、Node 22.18.0，Moli 1.1.19。使用自己启动的 loopback HTTP 页面和模拟 SSE，每 300ms 发送一段，不访问用户账号或真实聊天服务。下载归档的 SHA256 为 `65f389b4e9f71eb9bf2d879984bb1a599d9c09b171513bd2b9af3950e0fb15be`。

| 检查 | 结果 |
| --- | --- |
| 同源两个临时 context 的 cookies、localStorage、sessionStorage | 相互隔离 |
| 两路四段模拟回复流 | 在 EOF 前同时读到增量，750ms 时各收到两段 |
| Runtime.addBinding 的 session 归属 | 两路共八个增量事件，session 分开，无串流 |
| 删除 context A 时 context B 正在收流 | B 完成 |
| 创建附加持久化分区 | 返回 PersistentBrowserContextNotSupported，确认限制 |
| 两个独立进程使用不同 profile，杀掉 A | B 继续完成模拟流 |
| Browser.close 后重启原 profile | cookie 与 localStorage 恢复 |

可复现脚本：[smoke.mjs](smoke.mjs)。保存的结果：[results-macos-arm64-v1.1.19.json](results-macos-arm64-v1.1.19.json)。

```bash
node claw/research/moli/smoke.mjs /absolute/path/to/moli /tmp/moli-smoke-results.json
```

脚本无需额外 npm 依赖，使用 Node 22 的 fetch 与 WebSocket，创建临时 profile 和本地服务，结束时清理自己启动的进程。临时 profile 留在系统临时目录供排查，内容只含自建 fixture。七项检查覆盖基础能力，其中一项验证的是预期的能力拒绝，不代表七项产品功能已完成。

2026-10-25 的基础实验未测试 IndexedDB、真实站点认证、文件上传、模型切换、服务端 stop、真实对话恢复或账号限流。未对真实聊天负载测量内存、吞吐或长期稳定性；上游抓取 benchmark 的内存优势不能直接用于估计 N 个 chat 的容量。

## 建议的接入顺序

1. 在 BrowserHost 后增加可替换的 Moli 执行后端，第一版按 chat 隔离进程与 profile，保留 Chromium 回退。
2. 先用 ChatGPT 与 DeepSeek 验证真实发送和同时增量接收，禁用刷新恢复来检查实时链路；账号认证单独验证。
3. 补 Kimi 与 Claude 网页适配，再进行四站点混合运行和同站点多 chat。
4. 测试取消、服务端停止确认、worker 崩溃、持久化刷新和断连恢复。CLI 关闭不得误发 Browser.close 到共享进程。
5. 对真实负载测量 1、2、4、8 路的资源和成功率，通过后再决定是否修改 Moli 内核或降低进程隔离等级。

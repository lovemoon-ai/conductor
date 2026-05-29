# chat-web 孤儿浏览器占用 profile 锁导致后续任务无回复

- 类型: stable（会话执行失败 / 无 AI 回复 / 进程泄漏）
- 日期: 2026-05-29
- 关联线上任务: `e739d12a-c0c4-4e76-9df7-db0db7315e5c`（诊断见 `claw/issues/stable_task_e739d12a_chatweb_chromium_launch_failed_20260529.md`）

## 症状

用户发起一个 `web-chatgpt`（chat-web）任务后，约 11 秒就收到执行失败：
`初始提示执行失败: Failed to launch Chromium for "chatgpt" ... launchPersistentContext: Opening in existing browser session`。
首条回复从未产生，用户空等约 4 分钟后从 App 手动停止，任务以 `killed (stopped_from_app)` 结束。

## 根本原因

chat-web 的每个 provider 共用一个持久化 profile（`~/.chat-web/profiles/<provider>`），
Chromium 用 `SingletonLock` 守护该目录，同一时刻只允许一个实例。

前一天（05-28）那次 chatgpt 会话的 Chromium（PID 72329）**没有被回收**，活到第二天仍持有 `SingletonLock`。
新任务对同一 profile 调用 `launchPersistentContext` 时，Chromium 的 ProcessSingleton 把参数交给老实例后新进程立即退出，Playwright 因此报 `Opening in existing browser session`。

为什么老浏览器会变成长期存活的孤儿：
1. **ai-sdk worker 没有 SIGTERM/SIGINT handler**（只处理 uncaughtException / unhandledRejection / stdin-end）。worker 被信号终止时直接死亡，不会走 `closeSession()`。
2. worker 被父进程 SIGKILL 时，它 spawn 的 Chromium 来不及被 Playwright 清理，**孤儿化且继续存活**——锁是"活锁"而非死进程残留。
3. 没有任何机制限制 chat-web 任务的存活时长，孤儿可以无限期占用锁。

## 修复

三层防御（提交涉及 `modules/chat-web`、`modules/ai-sdk`、`cli`）：

1. **启动前回收 / 明确语义**（`modules/chat-web/src/core/profile-lock.ts`，在 `launchProviderBrowser` 中调用）：
   - 锁的 pid 已死 → 清理 stale 锁，启动。
   - 锁的 pid 存活但不是本 profile 的 Chromium（pid 复用）→ 清理 stale 锁，启动。
   - 锁的 pid 是本 profile 的 Chromium，但其 owner 进程已死 → **孤儿**，kill 接管。
   - 锁的 pid 与 owner 均存活 → 真正的 live chat，抛 `ProfileLockedError`（含占用 pid + 清理提示），不静默卡住。
   - owner 判定靠一个 sidecar 文件 `.chat-web-owner.json`（记录持有浏览器的 worker pid），`ChatSession.close()` 时清除。
2. **可靠关闭**（`modules/ai-sdk/src/worker.js`）：新增 SIGTERM/SIGINT handler → `closeSession()` → `context.close()`；并给 `closeSession()` 加 10s 超时，避免 `context.close()` 卡死导致 worker 不退出。
3. **限制活跃时长**（`cli/bin/conductor-fire.js`）：chat-web 任务默认最多活跃 24h（`CONDUCTOR_CHATWEB_MAX_ACTIVE_MS` 可调），到期优雅 abort runner + 关闭 backend session，最终状态记 `KILLED / max_active_duration`。聊天记录在 provider 账号与持久化 profile 中，关闭浏览器不会丢失。

测试：`modules/chat-web/tests/profile-lock.test.ts`（含 stale 清理、孤儿接管、live 拒绝三条核心路径）；cli/ai-sdk/chat-web 全量测试通过。

## 如何避免再次发生

- **凡是 spawn 外部长生命周期进程（浏览器、子进程）的 worker，必须在所有退出路径上回收**：补齐 SIGTERM/SIGINT handler，不要只依赖 stdin-end / 正常 close。
- **共享单例资源（单 profile 浏览器）要有"谁持有"的可观测标记**（owner sidecar）+ 启动前自愈，而不是假设上次一定关干净了。
- **长生命周期任务要有硬性活跃上限**，避免异常情况下无限期占用独占资源。
- 执行层首条 prompt 失败时应即时把失败原因回传 App（本例用户空等 4 分钟才手动停），避免"静默卡住"。

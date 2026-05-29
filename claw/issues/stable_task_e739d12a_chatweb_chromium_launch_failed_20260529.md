# 任务诊断：e739d12a chat-web Chromium 启动失败导致首条回复失败

- **Task ID**: `e739d12a-c0c4-4e76-9df7-db0db7315e5c`
- **诊断时间**: 2026-05-29
- **诊断方式**: `conductor diagnose <task-id> --json`，`source=live`（实时诊断，非 snapshot）
- **diagnose verdict**: `task_terminal` (high) — task is already killed

## 结论（先给判断）

这是一个**执行层（execution layer）**故障，**不是**路由 / websocket / host binding 问题。

- 后端 `web-chatgpt`（chat-web，基于 Playwright 驱动 ChatGPT 网页）在 fire 主机上**启动 Chromium 失败**，
  导致首条 prompt 执行失败，用户始终没拿到 AI 回复。
- 任务最终状态为 `killed`，终止原因是 **app 端主动停止**（`stopped_from_app`），即用户在等待约 4 分钟后从 App 手动停止，并非系统自动 kill。

最终状态层：`killed (stopped_from_app)`；根因层：execution / 后端浏览器启动。

## 关键信号

| 信号 | 值 |
| --- | --- |
| source | `live` |
| task.status | `killed` |
| latest_status_summary | `task stopped by app: stopped_from_app` @ 06:02:02 |
| task.agent_host | `m1` |
| task.execution_host | `conductor-fire-unknown-host-7631` |
| backend | `web-chatgpt` |
| messages.has_pending_user | `false`（无积压用户消息） |
| outbox.latest_for_pending_user | `null`（投递层无异常） |
| diagnosis.code | `task_terminal` |

注：`assigned_agent_connected=false`、`bound_agent_host=null` 属正常现象——任务已 killed，该 fire 主机已退出；当前另有 18 个 `conductor-fire-*` 在线。**不要据此误判为 host 离线问题。**

## 时间线（来自 fire_logs，daemon_host=`m1`，log_path=`/Users/duino/ws/fires/arxiv-radar-chat/conductor.log`）

```
05:57:48  用户发送消息：讨论 arXiv 论文《BrickCraft: ...》；tmux fire 会话创建并 detach
05:57:49  Attached to task；Using backend: web-chatgpt
05:57:53  chat-web: Chromium binary not found; 触发一次性安装 `npx playwright install chromium`
05:57:58  chat-web: Chromium 安装完成（6s）
05:57:59  SDK 回复：初始提示执行失败: Failed to launch Chromium for "chatgpt"
          at /Users/duino/.chat-web/profiles/chatgpt:
          browserType.launchPersistentContext: Opening i...   ← 错误文本被截断
06:02:00  Received stop_task (stopped_from_app); stopping conductor fire
06:02:02  task -> killed
```

## 根因分析

fire 主机此前**未安装 Chromium**，chat-web 触发了一次 JIT 安装（`npx playwright install chromium`），安装报告成功（6s）；
但紧接着用持久化 profile（`/Users/duino/.chat-web/profiles/chatgpt`）调用 `launchPersistentContext` 仍然失败。

**已在 m1 上确认根因：持久化 profile 被上一次会话残留的浏览器进程锁定。**

- chat-web 的 `chatgpt` provider 使用**单一共享**持久化 profile：`/Users/duino/.chat-web/profiles/chatgpt`。
- 该 profile 的锁仍被一个**遗留进程**持有：
  ```
  SingletonLock -> duinodeMacBook-Pro.local-72329
  PID 72329  Google Chrome for Testing (ms-playwright/chromium-1223)
             --user-data-dir=/Users/duino/.chat-web/profiles/chatgpt
             STARTED  Thu May 28 13:07:41 2026   ← 上一轮《VGGT-Ω》会话
  ```
  即 **05-28 13:07 那次会话的 Chromium 一直没退出**，到 05-29 13:57 新任务启动时仍然存活并占着锁。
- 新任务对同一 profile 调用 `launchPersistentContext` 时，Chromium 的 ProcessSingleton 检测到已有实例，把启动参数交给老实例后**新进程立即退出**，
  Playwright 因管道未建立而报错——被截断的 `Opening i...` 即 **`Opening in existing browser session.`**

`Chromium binary not found → 一次性安装` 只是附带现象（装的是 chromium-1223，与老进程同版本），**不是根因**；真正卡点是 profile 锁冲突。

## 证据缺口（已补齐）

- 进程级证据已坐实，无需再取生产 DB 全文。唯一未拿到的是 chat-web 侧 launchPersistentContext 的原始堆栈日志
  （chat-web 未把该错误落到 `~/.chat-web/logs/`，仅经 SDK 消息回传并被截断）——建议补充落盘。

## 建议后续动作

1. **启动前清理残留**：chat-web 启动某 provider 前，若对应 profile 存在 `SingletonLock` 且指向的 PID 仍存活，应先优雅终止该残留进程（或检测并复用），再 `launchPersistentContext`。
2. **会话结束必关浏览器**：fire/task 结束（含 `stopped_from_app`、异常退出）时确保 `context.close()` / 进程被回收，避免跨天残留占锁。本例 06:02 stop_task 时，05-28 的老进程根本不属于本 task，说明回收没有覆盖到。
3. **错误可读 + 落盘**：launch 失败时把完整 Playwright 错误写入 `~/.chat-web/logs/` 与 conductor.log，并向 App 即时回传可读原因，避免用户空等约 4 分钟后手动停止。
4. （可选）评估为并发任务使用**独立 profile 目录**，从根上消除单 profile 的锁竞争。

## 立即恢复手段

终止残留进程后即可恢复该 provider：`kill 72329`（会一并回收其子进程），随后重开任务即可正常 `launchPersistentContext`。

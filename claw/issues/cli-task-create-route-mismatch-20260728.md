# P1 — `task create` 报 409 且错误不透明（初诊“路由不匹配”已推翻）

## Status: RESOLVED (misdiagnosed as routing; real cause found)

## Symptom

`conductor task create` 在 `--dry-run` 显示 `POST /api/tasks`，实际执行报
`Error: Backend responded with 409`，任务未创建。QA Round 8 初步归因为 dry-run 与
执行走了不同的任务路由（/api/tasks vs /tasks）。

## 初诊为何是错的

`web/next.config.ts` 存在 rewrite：`/tasks/:path*` → `/api/tasks/:path*`。裸
`POST /tasks` 会被 Next 重写到同一个 `/api/tasks` handler。实测对比：

- 默认 project：`POST /tasks` 与 `POST /api/tasks` 都返回 `200`（建任务成功）。
- 绑定离线 daemon 的 project（QA 实际命中的 `2ff08277…`，daemonHost=`qa-daemon-2`）：
  两条路径都返回 `409 {"error":"Project daemon qa-daemon-2 is offline"}`。

即两条路径等价，路由不是问题。

## 真实根因

1. QA 的 `--project` 解析到的 project 绑定了离线的 `qa-daemon-2`，
   `web/src/app/api/tasks/route.ts` 因“daemon 离线”返回 409（预期的业务校验）。
2. CLI 的 `reportError()` 只打印 `error.message`（`Backend responded with 409`），
   吞掉了 `BackendApiError.details` 里的真实原因，导致 QA 只能对着裸状态码误判为路由。

## 修复

- `cli/src/entity-helpers.js reportError()` 现在追加后端 `details.error`/`message`：
  `Error: Backend responded with 409: Project daemon qa-daemon-2 is offline`。
- 新增 CLI 测试覆盖该路径。
- SDK 保留新增的 `createAppTask()`（显式 `POST /api/tasks`），作为语义澄清，非 409 修复。

## 验证

- `cd cli && node --test test/conductor-task.test.js` → 26 passed。
- `cd modules/conductor-sdk && pnpm test` → 127 passed。
- 实机：对绑定离线 daemon 的 project 执行 `task create`，输出已含真实原因。

详见 `claw/lessons/arch_cli_task_create_route_mismatch.md`。

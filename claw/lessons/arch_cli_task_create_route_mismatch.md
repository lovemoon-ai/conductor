# CLI 吞掉后端错误详情，导致 409 被误判为“路由不匹配”

## 症状

QA Round 8 报告：`conductor task create --dry-run` 显示将请求
`POST /api/tasks`，实际执行报 `Error: Backend responded with 409`，任务没有创建。
初步诊断为“dry-run 与执行走了不同的任务路由（/api/tasks vs /tasks）”。

## 根因（推翻初诊）

初诊是错的。`web/next.config.ts` 里有 rewrite：`/tasks/:path*` →
`/api/tasks/:path*`（`/projects`、`/agents`、`/events` 同理）。因此裸
`POST /tasks` 会被 Next 重写到同一个 `/api/tasks` handler，两条路径行为完全一致。
实测同一 project 下 `POST /tasks` 与 `POST /api/tasks` 均返回相同结果：

- 默认 project（daemon 在线/无绑定）：两者都 `200` 建任务成功。
- 绑定了离线 daemon 的 project：两者都返回
  `409 {"error":"Project daemon qa-daemon-2 is offline"}`。

真正的 409 来自 `web/src/app/api/tasks/route.ts` 的业务校验——目标 project 绑定的
daemon（`qa-daemon-2`）离线。QA 用 `--project` 解析到的正是这个绑定离线 daemon 的
project，所以任务建不出来。

之所以被误判为路由问题，是因为 **CLI 把后端返回的错误详情吞掉了**：
`cli/src/entity-helpers.js` 的 `reportError()` 只打印 `error.message`
（`Backend responded with 409`），忽略了 `BackendApiError.details` 里的
`{"error":"Project daemon qa-daemon-2 is offline"}`。QA 看不到真实原因，只能对着
一个裸状态码猜，于是猜成了路由。

## 修复

- `reportError()` 现在会从 `BackendApiError.details`（`{error}` 或 `{message}`，
  或字符串）提取后端原因并追加到输出：
  `Error: Backend responded with 409: Project daemon qa-daemon-2 is offline`。
- 增加 CLI 测试：`createAppTask` 抛出带 details 的 409 时，stderr 必须包含真实原因。
- 附带保留：`SDK` 新增 `createAppTask()` 显式请求 `POST /api/tasks`，让 app-task
  创建不再依赖 rewrite + 404 重试的隐式行为。这是语义澄清，**不是** 409 的修复。

## 如何避免再次发生

- CLI/SDK 报错必须透传后端的 `error`/`message` 详情；只打印状态码等于把诊断信息
  丢给用户去猜，极易把业务态（daemon 离线、绑定不全）误判成协议/路由问题。
- 诊断“路由不一致”类问题前，先确认是否存在框架级 rewrite（`next.config.ts`），
  再用 `curl` 对同一 project 直接对比两条路径的真实响应，而不是只看 CLI 报错。
- 复现 409 时要区分“同一路由不同 project”：绑定离线 daemon 的 project 会稳定 409，
  和路由无关。

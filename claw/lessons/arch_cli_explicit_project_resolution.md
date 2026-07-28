# CLI 显式 project 参数必须映射到 SDK 支持的字段

## 症状

用户执行 `conductor task create --project "Default Project"` 时，CLI 没有使用
指定项目，而是按当前工作目录选中了另一个项目。目标项目的 daemon 不在线时，
创建请求返回 HTTP 409。

## 根因

CLI helper 把 `--project` 写入 `ProjectsApi.resolveProject()` 的 `project` 字段，
但 SDK 的输入只支持 `id`、`name`、环境变量、cwd 和默认项目。TypeScript SDK
在 JavaScript 调用边界不会拒绝未知字段，导致显式参数被静默丢弃，后续 cwd
匹配看似正常地返回了错误项目。

## 修复

CLI helper 在发现非空 `--project` 后直接调用 `ProjectsApi.getProject()`；该方法
先按 id 查询，并在 404 时按唯一名称解析。没有显式参数时，才进入 SDK 原有的
环境变量、cwd 和默认项目优先级。

## 如何避免再次发生

- JavaScript 调用 TypeScript API 时，集成测试必须覆盖字段语义，不能只验证命令
  成功返回。
- 优先级测试要同时提供显式项目和可命中的 cwd 项目，断言显式参数获胜。
- SDK 输入对象新增或变更字段时，应在 CLI 边界进行明确映射；不要依赖未知字段
  会在运行时失败。

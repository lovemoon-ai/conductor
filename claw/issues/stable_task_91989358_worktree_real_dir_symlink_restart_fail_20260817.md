# stable: worktree symlink 目标是真实目录导致 restart 失败（2026-08-17）

## 结论

涉及任务：`91989358-bb7a-408e-acf9-c73961cfd086`「dsh」（project `62687a65`，
worktree `52eeb1`，daemon `macmini`，backend `claude`）。

任务处于 `killed` 后无法 restart。根因在 daemon worktree/symlink 准备执行层：

- worktree `52eeb1/cli/node_modules` 原本应是指向项目
  `cli/node_modules` 的 symlink，但被替换成了**真实目录**（784MB，
  mtime 2026-08-14 07:03，典型场景是在 worktree 内直接执行了
  `pnpm install`，pnpm 删除旧 node_modules 目录项后重建，链接被真目录覆盖）。
- `ensureTaskWorktreeSymlinks` 对「目标存在且不是 symlink」的分支直接
  `throw`，整个 worktree 准备失败，restart 在启动 Fire 之前终止。

诊断类型：`live`。层级：daemon worktree/symlink 准备执行层；
不是 outbox、websocket、host 绑定或 daemon 离线问题。

## 线上诊断快照

`conductor diagnose 91989358-... --json`：

- `status=killed`，`agent_host=execution_host=macmini`
- `bound_agent_connected=true`，`assigned_agent_connected=true`（macmini 在线）
- `latest_status_summary`：

```text
restart failed: worktree symlink destination already exists and is not a
symlink: /Users/wangwang/ws/conductor/.conductor/worktrees/52eeb1/cli/node_modules.
Refusing to replace it because it may hold real data — remove it manually, or
drop "cli/node_modules" from worktree.symlink in .conductor/settings.yaml.
```

本机验证：`readlink` 确认该路径不是链接而是真实目录；符合 daemon
`lstat → !isSymbolicLink() → throw` 的失败路径。

## 与既有问题的关系

同一缺陷家族的第三个变体，前两个见：

- `stable_task_836520ca_worktree_dangling_symlink_restart_fail_20260723.md`
  （悬空链接 → EEXIST）
- `stable_tasks_6c4df1c9_2fc582e1_reconcile_kill_symlink_restart_fail_20260731.md`
  （stale 链接 → abort，已改为 self-heal repoint）

前两次修复都把「abort」改成「收敛」，但「目标是真实文件/目录」分支仍然
throw，任何一个在 worktree 里 `pnpm install` 过的任务从此永远无法 restart。

## 恢复结果（2026-08-17 11:27 Asia/Shanghai）

1. 删除 worktree 内真实目录 `52eeb1/cli/node_modules`（node_modules 可再生，
   即错误信息自身给出的处置方式）。
2. 调用 `POST /api/tasks/91989358-.../restart`（`strategy=inplace`），
   返回 `mode=inplace_restart`。
3. 复验：symlink 已重建为 `../../../../cli/node_modules`；任务
   `status=running`，`execution_host=conductor-fire-unknown-host-11174`，
   bound + connected，`diagnosis.code=no_pending_user`。

已知残留（既有问题，非本次引入）：restart 成功后
`latest_status_summary` 仍显示上一次 `restart failed`，见 20260731 文档
「成功 restart 应清空或追加新的成功 status event」。

## 根因修复

`cli/src/daemon.js ensureTaskWorktreeSymlinks`：目标存在且不是 symlink 时
不再 throw，改为 `logError` + skip（保留本地真实数据，任务照常启动；
用户手动删除该路径即可恢复共享）。附回归测试
`cli/test/daemon.test.js`「keeps a real non-symlink destination and still
launches the task」。

注意：线上 macmini daemon 是 release 版进程，本修复要等下一次 release +
daemon 滚动重启才生效（参考 20260731 文档中「package 已发布 ≠ daemon
已运行新代码」的教训）。

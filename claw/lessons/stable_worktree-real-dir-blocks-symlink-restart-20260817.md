# stable: worktree symlink 目标被真实目录占据导致任务永久无法 restart

## 症状

线上任务 `91989358-bb7a-408e-acf9-c73961cfd086` 处于 `killed`，每次 restart
都失败，`latest_status_summary`：

```text
restart failed: worktree symlink destination already exists and is not a
symlink: .../worktrees/52eeb1/cli/node_modules. Refusing to replace it ...
```

daemon 在线、路由和 outbox 均正常，失败发生在 Fire 启动之前的 worktree 准备。

## 根因

`.conductor/settings.yaml` 的 `worktree.symlink` 配置了 `cli/node_modules`。
在 worktree 内直接跑 `pnpm install` 时，pnpm 会删除 node_modules 目录项并
重建，把 symlink 替换成真实目录。下一次 restart 时
`ensureTaskWorktreeSymlinks` 走到「目标存在且不是 symlink」分支直接
`throw`，整个 worktree 准备失败 → 任务永久无法 restart。

这是该函数第三个「abort 而不是收敛」的变体：悬空链接（EEXIST，20260723）、
stale 链接（20260731）都已改成 self-heal，唯独真实文件/目录分支仍然 throw。

## 修复

- `cli/src/daemon.js`：该分支改为 `logError` + skip——绝不覆盖真实数据，
  但保留本地副本继续启动任务；日志提示手动删除该路径可恢复共享。
- 回归测试：`cli/test/daemon.test.js`
  「keeps a real non-symlink destination and still launches the task」
  （无 symlink/unlink/rename 调用，且任务仍然 spawn）。
- 线上恢复：手动删除 worktree 内的真实 `cli/node_modules` 后
  `strategy=inplace` restart，任务已回到 `running`。

## 如何避免

1. worktree 准备中的防护性检查，失败处置默认应是「记录 + 降级收敛」，
   而不是让整个任务永久不可恢复；只有会破坏用户数据的操作才允许 abort。
   同一函数里三次同类缺陷（EEXIST / stale / real-dir）都是同一条教训。
2. `worktree.symlink` 配置的路径（node_modules、.venv 等包管理器管理的
   目录）随时可能被工具替换成真实目录，代码必须把「链接被真目录顶替」
   当作常态输入而不是异常。
3. 修复合入后要等 release + daemon 滚动重启才在线上生效；验收要看 daemon
   runtime version，不能只看 package 版本（20260731 已有教训）。

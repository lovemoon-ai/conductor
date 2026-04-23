# stable: worktree symlink 配置与 Git tracked 路径冲突导致任务创建即 killed (2026-04-23)

## 症状

- 线上 task 一创建就进入 `killed`，没有任何 user/sdk message。
- daemon 日志里可以看到 `Failed to create task ...: worktree symlink destination already exists: .../data`。
- 同一项目下，不同 backend 的新 task 都会稳定复现。

## 根因

- 项目 `.conductor/settings.yaml` 把 `data` 配进了 `worktree.symlink`。
- 但 `data/*` 本身是 Git tracked 内容，`git worktree add` 创建新 worktree 时会先把它正常检出为真实目录。
- daemon 随后再执行 symlink 注入逻辑时，发现目标路径已经存在且不是 symlink，于是直接抛错，create_task 失败后把 task 回写为 `KILLED`。

## 修复

- 从项目 `.conductor/settings.yaml` 里移除 `data`，避免继续把 tracked 目录当作共享 symlink 配置。
- 在 `cli/src/daemon.js` 中新增 Git tracked 检查：如果 `worktree.symlink` 里的路径已经被 Git 跟踪，则跳过 symlink，保留 worktree 自身检出的内容。
- 在 `cli/test/daemon.test.js` 中补充回归测试，覆盖：
  - 普通未跟踪路径仍会创建 symlink。
  - legacy `setttings.yaml` 兼容路径仍有效。
  - tracked 路径会被跳过，不再因已存在真实目录而失败。

## 如何避免

- `worktree.symlink` 只适合共享运行时产物或本地私有文件，不要配置 Git tracked 路径。
- 对“后处理 worktree 内容”的逻辑，必须先判断该路径是否属于 Git checkout 的一部分，不能默认覆盖。
- 所有会把 task 直接打成 `KILLED` 的创建失败路径，都应补带现场配置的回归测试。

# stable: Update daemon 失败时删掉了正在运行的安装，新任务一创建就 killed (2026-09-19)

## 症状

- apex 上新建的任务约 20 秒后变成 `killed`，没有任何 user/sdk message。
- `latest_status_summary` 为 `Cannot find module …/@love-moon/conductor-cli/bin/conductor-fire.js … MODULE_NOT_FOUND`。
- daemon 本身在线，diagnose 显示路由和绑定都正常（`task_terminal`）。
- 影响任务：`5cf6a127`、`abdfe3fa`、`9d610325`、`d6a5f392`。l20-yy 在 09-18 出现过同样的情况。

## 根因

- `cli/src/daemon-update.js` 在 `npm install -g` **任何**失败之后，都会先 `npm uninstall -g` 再 `rm -rf` 全局包目录，然后重试一次。这套逻辑原本只是为了应付 `ENOTEMPTY`。
- apex 访问 registry.npmjs.org 很慢，两次安装都跑满 15 分钟超时（`exit null`）。l20-yy 则是 node-gyp 编译失败（`exit 1`）。两种情况都不是 `ENOTEMPTY`，原有安装本来完好。
- 被删掉的目录正是 daemon 和它启动的每个 fire 的运行目录。重试失败后，更新器还报告 “daemon was left running on the current version”，但磁盘上的文件已经没了。daemon 靠内存里的代码继续在线，新的 fire 则全部起不来。

## 修复

- 只有安装输出里出现 `ENOTEMPTY` 时才执行清理加重试；超时、网络错误、编译失败时不动现有安装，直接报失败。
- `ENOTEMPTY` 分支不再 uninstall 或删除，而是把包目录改名为 `.conductor-cli-update-backup` 挪开。重试成功就删掉备份，失败就还原。
- `cli/test/daemon-update.test.js` 补了回归测试：超时不重试、不碰安装；`ENOTEMPTY` 重试失败时会还原。
- apex 的现场恢复：通过 npmmirror 重装 0.13.2，再用 `daemon --force --nohup` 重启，9 个 tmux fire 被新 daemon 接管。

## 如何避免

- 更新流程的承诺是“失败不影响正在运行的 daemon”，这条对磁盘上的安装目录同样成立，不只是进程还活着。任何删除当前运行包的操作都必须能回滚。
- 按错误类型决定恢复手段，不要对所有失败都用破坏性的恢复。
- 排查 “任务一创建就 killed、没有消息” 时，先看 `latest_status_summary` 和宿主机的 `daemon-update.log`。

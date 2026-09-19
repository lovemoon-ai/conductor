# apex：daemon 更新失败时删掉了正在运行的安装，所有新任务都起不来（2026-09-19）

任务：`d6a5f392-7e4b-42d9-b0a1-d6cb491275df`（项目 `d01c2c80…`，kimi，host `apex`）

## 结论

问题出在执行层，而且是**宿主机的安装被删掉了**，跟路由和 websocket 无关。
09-19 12:55 触发了 `update_daemon`（0.13.1 → 0.13.2）。apex 访问 registry.npmjs.org 很慢，`npm install -g` 两次都跑满 15 分钟超时被杀（`exit null`）。
在两次尝试之间，`cli/src/daemon-update.js` 执行了“清理坏安装再重试”：先 `npm uninstall -g`，再 `rm -rf` 全局包目录。被删掉的正好是 daemon 当前运行的 0.13.1 安装。
第二次安装也失败了，更新器打出 “daemon was left running on the current version”。daemon 进程靠内存里已加载的代码还活着，但磁盘上的 `conductor-fire.js` 已经不存在。之后 apex 上每个新任务一启动 fire 就报 `MODULE_NOT_FOUND`，退出码为 1，任务随之被标成 killed。

## 证据（live 诊断）

- `conductor diagnose`：`source=live`，`task_terminal`，`status=killed`，`agent_host=execution_host=bound=apex`，apex 在线，任务没有任何消息。
- `latest_status_summary`：`exited with code 1: …node-v23.11.0-linux-x64/lib/node_modules/@love-moon/conductor-cli/bin/conductor-fire.js … MODULE_NOT_FOUND … Node.js v18.19.1`
- apex `~/.conductor/logs/daemon-update.log`：
  ```
  04:55:33Z npm install -g @love-moon/conductor-cli@0.13.2
  05:10:33Z install failed (exit null); removing the broken install and retrying
  05:10:34Z removed /home/min.du/.conductor/node-v23.11.0-linux-x64/lib/node_modules/@love-moon/conductor-cli
  05:25:34Z FAILED: install failed (exit null):
  05:25:34Z daemon was left running on the current version
  ```
- `~/.npm/_logs`：两次 install 都卡在拉 manifest（`@love-moon/chat-web` 一个请求就用了 320s）。第一次 install 还没走到 reify，原有安装当时是完好的。
- 当前状态：`lib/node_modules/@love-moon/` 是空目录，`~/.conductor/bin/conductor` 成了坏的软链接。daemon PID 2493046（从 09-18 11:52 起在 `/usr/bin/node` v18 上跑 0.13.1）仍然在线。
- daemon 日志（`conductor-daemon.log`，上海时间）里同一原因失败的任务：`5cf6a127`（18:11）、`abdfe3fa`（18:12）、`9d610325`（18:14）、`d6a5f392`（18:26）。
- 同样的模式 09-18 在 l20-yy 上也出现过（`removing the broken install` 之后 `FAILED`）。

## 修复建议

1. **恢复 apex**（需要机主确认）：在 apex 上重新安装 0.13.2 并重启 daemon，例如在 UI 再点一次 Update daemon，或执行 `npm install -g @love-moon/conductor-cli@0.13.2` 后按 tmux 诊断记录里的干净重启方式重启。apex 的 npm 网络慢，建议先设 registry 镜像，或调大超时。
2. **代码**（`daemon-update.js` 第 423–441 行）：
   - 只在确实是坏安装的错误（如 `ENOTEMPTY`/`EEXIST`）时才走 uninstall + `rm -rf`。超时（`code=null`）或网络错误时，不要动现有安装。
   - 或者在删除前先把包目录 rename 备份，重试失败后再 rename 回来，这样 “daemon was left running on the current version” 这句话才成立。
   - 更新失败但安装已被删掉时，必须明确报错，并让 daemon 拒绝接新任务（或返回可读的 “install missing, rerun update”），不要让任务静默 killed。

## 处理（2026-09-19 19:20）

- apex：用 `npm install -g @love-moon/conductor-cli@0.13.2 --registry https://registry.npmmirror.com` 重装（`npm_config_prefix` 指向 `~/.conductor/node-v23.11.0-linux-x64`，耗时 3 分钟），再用 `env -u TMUX -u TMUX_PANE ~/.conductor/bin/conductor daemon --force --nohup` 重启。新 daemon PID 110516 运行 0.13.2，接管了 9 个 tmux fire，`conductor-fire.js --version` 正常。
- 代码：见 `claw/lessons/stable_daemon-update-deleted-running-install-20260919.md`。

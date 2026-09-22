# stable: 首条消息以 "-" 开头时 AI 永远收不到，任务静默无回复

## 症状

新建任务时，如果第一条消息以 `-` 开头（markdown 列表、`--model ...`、
`-i xxx` 等），任务会显示 `claude session started`，之后再无任何回复。
聊天里能看到用户消息，daemon、fire 都在线，Fire 的 `conductor.log` 只有
`Attached to Conductor task` / `Using backend` 两行，没有处理初始提示的记录。

本地复现：`initial_content = "- Do not use any tools.\n- Reply with exactly: DASH-OK"`，
旧版本一直无回复；修复后立刻回复 `DASH-OK`。

## 根因

daemon 通过 `buildFireSpawnArgs` 把首条消息作为两个 argv 传给 Fire：
`--prefill <content>`。Fire 用 yargs 解析，当 `<content>` 以 `-` 开头时，
yargs 把它当成一个新的 flag，而不是 `--prefill` 的值，于是
`conductorArgs.prefill` 为空，`initialPrompt` 为空，
`shouldProcessInitialPrompt=false`，第一轮根本不会发给 AI。
消息已经写进了数据库，但 Fire 不会从数据库补拉这条消息，所以任务一直空转。

## 修复

- `cli/src/daemon.js`：`buildFireSpawnArgs` 改为传 `--prefill=<content>`
  （`=` 形式下，yargs 把等号后面的内容整体当作值）。「New task from this」
  自定义首条消息也走同样的形式。
- 回归测试：`cli/test/conductor-fire-args.test.js`
  「daemon -> fire first message」：用 daemon 的 `buildFireSpawnArgs`
  生成 argv，再用 Fire 自己的 `parseCliArgs` 解析，断言 `initialPrompt`
  和原文完全一致（覆盖 `- 列表`、`--model`、`-i`、`0.10`、`/goal`）。
  旧写法下 3 个以 `-` 开头的用例失败。

## 如何避免

1. 跨进程传递任意用户文本时，不要用「flag + 独立值」的 argv 形式交给
   通用参数解析器；用 `--flag=value`、环境变量或文件。
2. daemon 和 Fire 之间的 argv 是一份协议：测试要同时跑两端
   （生成 argv 的函数 + 真实解析函数），而不是只断言 argv 数组长什么样——
   原有测试只检查了 `args[i + 1] === content`，看不出解析端会丢值。

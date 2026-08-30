# 创建任务对话框没有 prompt 入口，多 agent 组建完就干等

## 症状

在创建任务对话框里选好多个 agent（worker + reviewer）建任务，任务确实都创建出来
了、worktree 也对，但**没有任何一个 agent 真的开始干活**。worker 起来之后就停在
那里，reviewer 也没有东西可 review。

## 根因

后端这条链路本来是通的：

- `POST /api/tasks` 接受 `initial_content`
- 多 agent 时 `buildAgentBootstrap()` 把它拼进 worker 的开场白 `--- Task ---` 段
- 单 agent 时它原样成为任务的第一条消息，派发给 daemon

`CreateTaskInput` 里也早就声明了 `initialContent?: string`。

**唯独 `CreateTaskDialog` 从来没提供过这个输入框**，也就从来没发送过
`initialContent`。于是 worker 的开场白只剩下：

```
[conductor:agent] You are the "feature-dev" agent for this task group (your role: worker).
Read and follow your agent doc: personas/feature.md
```

—— 只有"去读你的 agent doc"，没有任何任务内容。agent 读完 doc 就没事可做了。
reviewer 那边其实是正常的（能通过 `conductor task group` 找到 worker），但 worker
什么都没产出，自然也没东西可 review。整个组就这么僵住。

单 agent 场景下这个缺失不致命：用户习惯"先建任务，再到聊天框里输入"，所以没人注
意到对话框少了个字段。但多 agent 组是**创建即启动**的，没有"再补一句"的时机，缺
失就直接变成功能不可用。

## 修复

对话框加一个可选的 Prompt 文本框（仅 ai_task 显示，PTY 是 shell，给 prompt 无意
义），接到 `initialContent`：

```ts
...(taskType === 'ai_task' && trimmedInitialContent
  ? { initialContent: trimmedInitialContent }
  : {}),
```

条件只看 `taskType`，与选没选 agent 无关，所以两条路径行为一致：

- 单 agent：原样作为第一条消息，agent 直接跑
- 多 agent：进第一个 agent（worker）bootstrap 的 `--- Task ---` 段

留空时整个字段不发送，"先建后聊"的老习惯不受影响。

## 下次如何避免

- **后端支持某个字段 ≠ 用户能用上它。** 这个 bug 里 API、类型、bootstrap 拼装全
  都是对的且有测试覆盖，唯独没人从 UI 走通一遍。加 API 能力时要顺带确认调用方
  真的传了。
- **"创建即启动"的功能不能依赖用户事后补输入。** 单 agent 可以靠"建完再聊"兜底，
  多 agent 组没有这个兜底 —— 同一个缺失在两种模式下的严重程度完全不同。新增一
  种"一次创建多个实体"的模式时，要重新检查原来靠事后交互兜底的环节。
- **测试要覆盖"用户实际路径"，不只是 API 契约。** 当时
  `agent-group.test.ts` 断言了"有 prompt 时会出现 `--- Task ---`"，
  `route.test.ts` 断言了 worker 的 `initialContent` 含用户 prompt —— 两条都通过，
  但都是直接喂 `initial_content` 的，没有一条从对话框出发。缺的正是最前面那一段。

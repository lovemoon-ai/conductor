# 多 agent 任务组的工作目录被拆到两个路径

## 症状

创建任务时选择多个 agent（1 个 worker + N 个 reviewer），并勾选 `worktree`：

- worker 任务运行在 `<workspace>/.conductor/worktrees/<branch>/`
- 每个 reviewer 任务却运行在项目根目录 `<workspace>/`

同一个 group 的成员被拆到两个不同的目录里。reviewer 看不到 worker 在 worktree
里写的代码，review 的是 base 分支的旧内容；worker 的改动也不会出现在 reviewer
的 `git status` 里。不勾选 `worktree` 时行为是对的（全部在项目根目录）。

## 根因

`web/src/app/api/tasks/route.ts` 的 POST 只对 **worker** 做了 worktree 解析：

```ts
if (worktreeRequested) {
  launchConfig = buildTaskWorktreeLaunchConfig({ ... });   // worker：worktree 字段齐全
} else {
  aiLaunchConfig.cwd = projectWorkspacePath;               // 非 worktree：项目根目录
}
```

而后面 spawn sibling reviewer 的循环里，`reviewerLaunchConfig` 是**从零重新拼**
的，完全没有看 worker 最终的 `launchConfig`：

```ts
const reviewerLaunchConfig: JsonObject = {
  ...(reviewerBackendType ? { backendType: reviewerBackendType } : {}),
  ...(projectWorkspacePath ? { cwd: projectWorkspacePath } : {}),          // ← 永远钉在项目根
  ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),  // ← 项目分支，不是任务 worktree 分支
  initialContent: reviewerInitialContent,
};
```

两个关键点：

1. reviewer 的 launch config 里没有 `worktree: true` / `worktreeId` /
   `projectRepoRoot`，daemon 侧 `parseTaskWorktreeLaunchConfig` 直接返回 null，
   于是不会进 worktree 分支，落回 `cwd`。
2. 这里的 `projectWorktreeBranch` 是 **project 表的 `worktree_branch`**（项目当前
   所在分支，例如 `main`），跟 `buildTaskWorktreeLaunchConfig` 现场随机生成的
   6 位 hex 任务分支名完全是两回事。名字像所以容易看混。

daemon 侧的目录是**只按 `worktreeBranch` 算**的
（`cli/src/daemon.js` `buildTaskWorktreeRoot`），所以只要分支一致，多个任务天然
共享同一个 worktree —— branch/fork 任务本来就依赖这个行为。reviewer 只是从来没
拿到那个分支。

## 修复

分两层：**共享身份，但只有一个 owner 负责创建**。

### 1. web 侧：reviewer 继承 worker 的 worktree 身份，并标记为 reuse-only

```ts
const sharedWorktreeLaunchConfig = inheritTaskWorktreeLaunchConfig(launchConfig, {
  reuseOnly: true,
});
// ...
const reviewerLaunchConfig: JsonObject = {
  ...(reviewerBackendType ? { backendType: reviewerBackendType } : {}),
  ...(sharedWorktreeLaunchConfig ?? {
    ...(projectWorkspacePath ? { cwd: projectWorkspacePath } : {}),
    ...(projectWorktreeBranch ? { worktreeBranch: projectWorktreeBranch } : {}),
  }),
  initialContent: reviewerInitialContent,
};
```

`inheritTaskWorktreeLaunchConfig` 原样拷贝 7 个 worktree 字段并加上
`worktreeReuseOnly: true`；未勾选 worktree 时返回 null，自动落回原来的项目根目录逻辑。

### 2. daemon 侧：reuse-only 只等待、不创建；owner 之间按 root 串行

- `ensureTaskWorktree` 拆出 `prepareTaskWorktree`，用
  `taskWorktreePreparations`（Map，key 是 worktree root）串行化同一个 root 的准备
  过程。原来 daemon 里**没有任何 per-root 锁**，worker 和 N 个 reviewer 的
  start_task 几乎同时到达，会一起通过 `existsSync(<root>/.git)` 检查然后同时
  `git worktree add -b`，只有一个能赢。
- `worktreeReuseOnly` 的成员走 `waitForSharedTaskWorktree`：先 await 同进程内
  owner 的准备 Promise（覆盖 worktree add + submodule + symlink 全过程），否则轮询
  `.git`，超时 180s 报错。**全程不执行任何 git 命令。**

## 为什么不能只给 reviewer 一个 `cwd`

这是这次修复里最容易踩的坑。daemon 确实认 `launchConfig.cwd`，所以「只给 reviewer
一个 `resolveTaskWorktreeCwdFromLaunchConfig()` 算出来的 cwd」看起来能让它跑对目录。
但 `hasSameTaskWorktreeRoot()` 依赖 `parseTaskWorktreeLaunchConfig()`，后者要求
`worktree` / `worktreeId` / `worktreeBranch` / `projectRepoRoot` /
`projectWorkspacePath` **全部存在**，否则返回 null。

于是只带 cwd 的 reviewer 会被判定为**不共享** worktree root，`teardown.ts` 的兄弟
任务守卫失效 —— worker 归档时带 `force: true` 把整个 worktree 删掉，而 reviewer 还
在里面跑。

所以 reviewer 必须保留**完整的 worktree 身份字段**（teardown 才数得到它），
再用一个额外的 `worktreeReuseOnly` 标记来区分「共享」和「负责创建」。
`teardown.test.ts` 里有一条测试专门锁这个：把 reviewer 的 launchConfig 换成只带
`cwd`，cleanup 立刻被入队，测试失败。

## 两个 review 才发现的后续问题

### 1. restart 会把 `worktreeReuseOnly` 丢掉

`inheritTaskWorktreeLaunchConfig` 最初只在显式传 `options.reuseOnly` 时才写这个
字段，而两条 restart 路径都是不带 options 调的
（`api/tasks/[taskId]/restart/route.ts`、`lib/tasks/inplace-restart.ts`）。
于是重启一个 reviewer → 新 launch_config 丢掉标记 → daemon 走 owner 分支，它又变成
一个会去 `git worktree add -b` 的成员。

修法是让标记**粘住**：

```ts
...(options?.reuseOnly || parsed.worktreeReuseOnly ? { worktreeReuseOnly: true } : {})
```

教训：**新增的"角色/模式"字段必须检查所有 launch_config 的继承路径**，否则一次
restart 就把角色洗掉了。`parseTaskWorktreeLaunchConfig` 当时已经解析出这个字段，
只是 inherit 时没带上 —— 解析和继承是两套代码，加字段要同时改。

### 2. `.git` 不是"准备完成"的信号

reuse-only 成员原本等 `.git` 出现就返回。但 `.git` 在 `git worktree add` 返回的
瞬间就存在了，而 submodule sync 和 symlink 还没做。如果 owner 在这中间失败（比如
submodule sync 撞上 120s 超时），`finally` 会把 in-flight Map 的条目删掉，此时
`.git` 已存在 —— 后到的 reviewer 立刻返回，进到一个缺 symlink 的半成品目录里。

改成 owner 在**全部准备完成后**才落一个 ready 标记，就绪条件是
`.git` 与标记同时存在：

- 标记放在 worktree **外面**（`<root>.ready`）：放里面会被
  `git status --porcelain` 看成 untracked，导致非 force 的 cleanup 全部被
  "Worktree has uncommitted changes" 挡掉。
- 就绪条件要求 `.git` **也**存在：worktree 被我们的 cleanup 之外的方式删掉
  （用户手动 `git worktree remove` / `rm -rf`）会留下孤儿标记，只看标记就会误判就绪。
- cleanup 成功后主动删标记；owner 重建前也先清一次陈旧标记。

教训：**用"副产物存在"来判断"流程完成"几乎总是错的。** 要用一个只在最后一步写入
的显式完成标记，并且让它和被保护的资源本身"同时成立"才算数。

## 下次如何避免

- **一次请求创建多个任务时，派生任务要从主任务的最终 launch config 继承，不要
  重新拼一份。** 重新拼 = 两条独立的解析路径，早晚漂移。
- **注意 `project.worktreeBranch` 与任务 `launchConfig.worktreeBranch` 是两个不同
  的东西**：前者是项目当前分支，后者是任务 worktree 的随机分支名。
- **"共享资源"和"负责创建资源"是两件事，要分开建模。** 直接让所有成员都带
  `worktree: true` 会把「共享」误当成「各自创建」，在没有锁的前提下必然打架。
- **改动会把一条罕见路径变成默认路径时，要重新评估它的并发假设。** worktree 共享
  原本只发生在 fork/branch 这类时间上错开的场景，竞争几乎碰不到；一旦变成每个多
  agent 组的默认路径，那条竞争就是必然事件。
- **身份字段既被"运行时"用也被"生命周期管理"用时，删字段要检查两边。** 这里
  worktree 字段同时服务于 daemon 的 cwd 解析和 teardown 的引用计数，只满足前者会
  静默破坏后者。
- **测试要覆盖"特性组合"，而不只是各自的单点。** 多 agent 分组和 worktree 各自都
  有覆盖，但交叉路径此前没有任何断言。
- **写完测试要先确认它会失败。** 本次第一版 daemon 测试预先创建了 `.git`，而旧代码
  在 `.git` 存在时同样会跳过 `worktree add`，所以它在修复前后都通过 —— 什么都没证明。
  必须构造真实的竞争时序（`.git` 一开始不存在）才有区分度。

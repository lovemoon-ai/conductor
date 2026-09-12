# arch: rewrite 别名绕过按 `/api` 前缀判定的鉴权门 —— 兼 `/agent/events` 每次先 404

- 发现：2026-09-01 QA 扫 `server.log` 非 2xx 看到 `POST /agent/events 404`；
  2026-09-12 复核该 bug 时，顺藤摸到一个**已上线的越权漏洞**
- 层次：路由（conductor-sdk ↔ web API）+ 鉴权（`getAuthUser`）
- 严重度：表层路由问题 P3；牵出的 daemon_share 越权 **P0**

## 一、表层症状

```
POST /agent/events 404 in 18ms
```

约 40 分钟 QA 会话出现 29 条，均匀分布，即每个 agent event 一条。

`client.ts` 里绝大多数调用用**不带 `/api` 前缀**的路径，靠 `next.config.ts` 的 `rewrites()`
映射到真正的 `/api/...`。但 rewrite 表只覆盖了 `/auth`、`/projects`、`/tasks`、`/agents`、
`/events`。SDK 提交事件用的是 `/agent/events`（**单数**，`/agents` 是复数的 agent 注册表），
没有 rewrite 命中；`/issues` 同样漏掉。

**但事件并没有丢。** 原 issue 判断为「telemetry silently dropped」是错的：
`BackendApiClient.request()` 有 404 → 补 `/api` 前缀重试的兜底。真实 client 打真实 server 的轨迹：

```
POST /agent/events     -> 404
POST /api/agent/events -> 200   # {"event_type":"sdk_message",...,"duplicate":true}
```

payload 形状也没问题（能走到 route 里 `killed` 任务的 split-brain 分支，说明 Zod 校验过了，
不是 400）。真实代价只有每个事件多一次往返 + 日志噪音。

## 二、真正的问题：rewrite 别名 = 鉴权旁路

修这个 404 最自然的做法是「再补两条 rewrite」。补之前先问了一句
**「rewrite 过去之后，handler 看到的 pathname 是哪个？」** —— 这一问挖出了真问题。

写了个探针 route 实测：

| 请求 | handler 里的 `request.nextUrl.pathname` |
|---|---|
| `/api/agents/zzpathprobe` | `/api/agents/zzpathprobe` |
| `/agents/zzpathprobe`（经 rewrite） | **`/agents/zzpathprobe`** ← 原始未加前缀的路径 |

Next 在调用 handler 前会把 request 的 URL 还原成 **rewrite 之前**的那个。

而 `web/src/lib/auth/middleware.ts` 里 daemon_share 的四层防御，第一道就是：

```ts
const pathname = normalizeSharePath(request.nextUrl.pathname);
// 「Falling through is safe: nothing outside `/api` authenticates via
//   `getAuthUser`, so a non-API path reaches Next's router and 404s」
if (!pathname.startsWith("/api/") && pathname !== "/api") return user;   // ← fail-open
```

注释里的前提**是假的**。有 rewrite 在，`/tasks/t1` 根本不会 404，它会打到真 handler。
线上实测（未修复的 6152）：

```
/tasks/probe        -> 401   # 不是 404
/auth/tokens/latest -> 401
/agents             -> 401
```

于是：**daemon_share token 只要把 `/api` 前缀去掉，四层防御全部跳过。**
后果按 `scope.ts` 自己的注释来说：

- `POST /agents/<别人的 host>/exec` —— 该模块注释明说「驱动*别的* daemon 是靠
  `isResourceInShareScope` 的 host-pinning 拦的，不是靠不给这条路由」。pinning 被跳过
  ⇒ **在 share 范围外的机器上远程执行命令**。
- `GET /auth/tokens/latest` —— allowlist 明确拒绝（会发凭证），去掉前缀即可拿到。
- 全部 `/tasks`、`/projects`、`/issues` 行级 host 绑定失效。该模块注释：
  「reaching *all* of the grantee's rows IS the escalation」。

这是**已存在**的漏洞（`/tasks` `/projects` `/agents` `/auth` 四条 rewrite 都中），
而「再补两条 rewrite」会把 `/agent/*`、`/issues/*` 也拉进来。

更糟的是 `middleware.test.ts` 有一条测试把这个 fail-open **锁死**了，理由写的就是那个假前提
（"so the SDK's prefix probe still 404s"），用的还是 `/tasks/t1` 这个**恰好有 rewrite** 的路径。
测试替假设背了书，于是没人再去验假设。

## 三、修复

1. 新增 `web/src/lib/api-rewrites.ts` 作为**唯一**别名来源：
   `next.config.ts` 用它生成 rewrite 表，`getAuthUser` 用它解析路径，两边无法漂移。
2. `getAuthUser` 在**做任何判断之前**先把别名解析成真实路由：
   ```ts
   const pathname = resolveRewrittenApiPath(normalized);   // /tasks/t1 -> /api/tasks/t1
   ```
   没有别名认领的路径原样返回，仍然 fall through 让 Next 去 404 —— SDK 的 404 探测语义保留。
3. 顺带补上 `/agent`、`/issues` 两个别名（现在补是安全的），以及
   `nginx_conf` 里文件传输 `location` 的 `^(/api)?/...`，否则不带前缀的那道门会掉进
   `location /` 吃默认 60s 超时，大文件传输 504。
4. `RAW_BODY_PATHS` 补上单数的 `/api/agent/files/<id>/content`。它之前只列了复数的
   `/api/agents/<host>/files/...`，而 `cli/src/remote-file-handlers.js` 推分片用的正是单数那条
   —— 于是 share token 的每个 32 MiB 分片都被 `clone()` + JSON buffer 进堆，正是这份名单
   存在的意义所在。这条是**既有** bug（`/api` 那道门本来就中），把 `/agent` 加进别名表后
   第二道门也会走到，所以一并修掉。

实测修复后：`POST /agent/events -> 200`，单次请求无重试；`/issues` `/projects` `/tasks`
`/agents` `/events` 全部照常。

## 四、下次如何避免

新增 `web/src/lib/api-rewrites.test.ts`：扫 `conductor-sdk/src/backend/client.ts` 和
`cli/src/daemon.js` 里构造的后端路径，断言每条都能经 `resolveRewrittenApiPath` 落到
`/api/...`；并断言 `next.config` 的 rewrite 表就是共享表、每条 `destination === "/api" + source`。
`middleware.test.ts` 补两条：别名路径必须被 scope 检查、`/auth/tokens/latest` 的别名必须被拒。
两组都验过**反向会红**（删掉别名 / 退回 `nextUrl.pathname` 立刻失败）。

通用教训，按重要性排：

1. **URL 重写会让「按路径前缀做鉴权」失效。** 只要框架把 rewrite 前的 URL 还原给 handler，
   前缀就是调用方可控的，不是服务端事实。鉴权要么用解析后的路径，要么别用路径前缀当开关。
2. **加一条 rewrite 等于给 handler 开第二扇门。** 开门前必须问：这扇门经过同样的鉴权吗？
3. **注释和测试里写的「这里是安全的，因为 X」，X 要当场验，不要读代码推。**
   本次假前提是「非 `/api` 路径会 404」，一条 `curl` 就能证伪，但它在注释和测试里躺了很久。
4. **不要拿「接口返回 200」当路由正确的证据** —— 有兜底重试时 200 可能来自第二跳。
   要看请求轨迹（本次靠包一层 `fetchImpl` 打印 URL + 状态码才看清）。
5. **兜底重试应当同时留计数/告警**，否则它就是个静音的性能债，还会掩盖路由错误。
6. **单复数路径（`/agent` vs `/agents`）是最容易漏的一类**，而且会连着漏好几处：
   本次 rewrite 表、`nginx_conf` 的超时 `location`、`RAW_BODY_PATHS` 三处都只写了复数。
   新增一个只差单复数的路由时，把这三处（以及任何按路径正则做决策的地方）一起 grep 一遍。

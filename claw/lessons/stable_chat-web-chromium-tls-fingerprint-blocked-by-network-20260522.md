# chat-web Chromium 被中间网络 DPI 指纹阻断（curl 通、Chromium 不通）

- Date: 2026-05-22
- Module: `modules/chat-web/src/core/navigate.ts`（新增）+ `providers/chatgpt.ts` / `providers/gemini.ts` 的 `open()`
- Surfaced by: 任务 `3761d730-4ca4-4d58-a884-243a8beacc0e`，`web-gemini 处理失败: page.goto: net::ERR_TIMED_OUT at https://gemini.google.com/app`

## 症状

用户提了 `web-gemini` 任务，daemon 启动 ChatWebSession → ChatGPT/Gemini 适配器 → `page.goto(homeUrl)` → 30s+ 后报 `net::ERR_TIMED_OUT` 或 `net::ERR_CONNECTION_CLOSED`。

特征：

| 测试 | 结果 |
|---|---|
| `curl https://gemini.google.com/app` | ✅ 200, 1-2s |
| `curl https://chatgpt.com/` | ✅ 应答正常 |
| **Playwright Chromium `headless: true`** goto | ❌ `ERR_TIMED_OUT` 30s |
| **Playwright Chromium `headless: false`** goto | ❌ `ERR_CONNECTION_CLOSED` 5s |
| Playwright Chromium goto `example.com`、`www.google.com` | ❌ 同样 timeout |
| Fresh empty profile + Playwright Chromium | ❌ 同样 |

**关键观测**：

- DNS 走 192.168.31.1（路由器）返回 `108.160.167.156`（DropBox CDN，明显 hijack 后的过时记录）；走 8.8.8.8 返回 `198.18.0.4`（IANA benchmark/blackhole 段）。
- curl 实际连到的远端 IP 是 `174.37.54.20`（SoftLayer/IBM cloud，不属于 Google 任何已知 ASN），说明**中间有路由级代理在重写 Google 流量**。
- Chromium 发起的 ClientHello / TLS 握手指纹和 curl 不同 —— 中间代理对 curl 放行、对 Chromium 默认 drop（DPI fingerprinting）。

= **用户本地网络对 Chromium 的 TLS 指纹做了选择性阻断**。chat-web 改不了网络层，但能改善的是 **稳健性 + 错误可操作性**。

## 修复

新增 `src/core/navigate.ts`，提供两个公开 API：

```ts
gotoWithRetry(page, url, { timeoutMs, attempts, backoffMs, waitUntil })
gotoOrThrowNetworkError(page, url, providerName, options)
```

行为：

1. **`waitUntil: "commit"`**（默认）—— 比之前的 `domcontentloaded` + `load` 链快得多。`commit` 在 Playwright 里只等到服务器响应头到达，不等任何子资源。chat 站点资源动辄几十个，等到 `load` 经常被慢/被代理的 CDN 拖死，而 composer 准备好与否我们用 locator wait 自己管。
2. **指数 backoff 重试**（默认 3 次，1.5s 基线）。只对 **transient 错误**重试 —— `ERR_TIMED_OUT` / `ERR_CONNECTION_CLOSED` / `ERR_CONNECTION_RESET` / `ERR_ABORTED` / `ERR_NETWORK_CHANGED` / plain navigation timeout。
3. **不重试永久错误** —— `ERR_NAME_NOT_RESOLVED`（DNS）/ `ERR_CERT_*`（TLS）/ `ERR_BLOCKED_BY_*`（被本地阻挡），重试浪费时间。
4. **最终失败时抛 typed `ChatWebError`**，code = `BROWSER_LAUNCH_FAILED`，hint 明确指向"proxy / DPI / TLS fingerprint"：
   > Chromium could not reach https://gemini.google.com/app for "gemini" (page.goto: net::ERR_TIMED_OUT…).
   > 
   > Hint: curl from the same shell may still work — that usually means the local proxy / DNS box is DPI-fingerprinting Chromium's TLS handshake. Try a different proxy that supports browser traffic, switch networks, or wait for the route to stabilise.

ChatGPT + Gemini 两个适配器的 `open()` 改成调 `gotoOrThrowNetworkError`，不再手写 `goto + catch + goto`。

测试 `tests/navigate.test.ts` 12 个 case 覆盖：error pattern 识别、retry 计数、backoff 关停、AbortSignal、permanent 错误不重试、最终错误包装。

## 如何下次避免（用户侧）

chat-web 改不了用户的网络，但可以告诉用户怎么自查：

1. **看 hint**：错误信息现在直说 "curl 通 / Chromium 不通 = DPI fingerprint 嫌疑"。
2. **换代理**：当前的 "router + DNS rewrite + 中间盒" 路径对 curl 友好、对浏览器不友好。换成走 V2Ray / Clash / SOCKS5 等支持完整 TLS 转发的代理（Chromium 通过 `--proxy-server=socks5://127.0.0.1:xxxx` 用），代理会拿到 Chromium 原始的 TLS 流量并完整转发到 Google，而不是被中间盒指纹识别。
3. **临时切换网络**：手机热点、有线网、不同 ISP 都可能换出问题。
4. **稍等再试**：DPI box 的阻断有时间窗口，过几分钟可能放行（重试机制会自动尝试 3 次，每次 1.5s × 2^n backoff）。

## 如何下次避免（chat-web 维护侧）

1. **永远不要假定"curl 通 = Chromium 通"**。两者的 TLS 指纹完全不同，企业网 / 国内运营商 / VPN 中间盒经常对 Chromium 区别对待。任何"为什么这个站连不上"的诊断，先做 curl + Chromium 双侧验证。

2. **永远不要在 SPA 上 `waitUntil: "load"`**。SPA 的 `load` 事件会被分析、字体、第三方 CDN 等任意一个慢资源 hold 住，目标信号永远应该是**具体的可交互元素 visible**（用 `locator.waitFor`），而不是页面级 lifecycle。

3. **重试要按错误类型分类**：transient（TIMEOUT/RESET/ABORT）retry；permanent（DNS/cert/blocked）immediately bubble。盲目重试 DNS 错误就是浪费 N×timeout。

4. **错误信息要有 "下一步该做什么"**。抛 `net::ERR_TIMED_OUT` 给上层用户是 50% 的诊断；说 "Chromium 连不通 X，curl 可能通 → 怀疑 DPI proxy → 换代理 / 切网络"，是 100% 诊断 + 可操作指引。

## 相关代码

- `modules/chat-web/src/core/navigate.ts`（新）
- `modules/chat-web/src/providers/chatgpt.ts`（`open()` 改用 `gotoOrThrowNetworkError`）
- `modules/chat-web/src/providers/gemini.ts`（同上）
- `modules/chat-web/tests/navigate.test.ts`（新，12 cases）

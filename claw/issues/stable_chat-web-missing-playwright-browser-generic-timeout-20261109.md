# web-kimi / web-deepseek fail with a generic "Chat worker timed out" when the Playwright browser build is missing

- Severity: P2 (minor). Only affects the opt-in `web-*` backends.
- Layer: execution (chat-web isolated runtime)
- Found: QA for the 0.18.0 candidate, 2026-11-09. The RC was installed from `npm pack` tarballs, which resolve `playwright` 1.65.0 because chat-web declares `^1.48.0`.
- Status: reproduced twice

## Reproduction
1. Use a host whose `~/Library/Caches/ms-playwright` lacks `chromium_headless_shell-1254`, the build that playwright 1.65.0 needs. Any host whose last `playwright install` came from an older version is in this state.
2. Configure a daemon with `web-kimi: chat-web --model kimi --headless` and a saved Kimi login.
3. Create a web-kimi task and send it a message.

## Expected vs observed
- Expected: the runtime installs the browser, or the chat shows an actionable message such as "run `npx playwright install chromium-headless-shell` on the daemon host".
- Observed: every message fails after about 60 s with `初始提示执行失败: Chat worker timed out` or `web-kimi 处理失败: Chat worker timed out`. The browser cache is never populated.
- Only `conductor chat-web turn get <id>` shows the real cause: `Failed to launch Chromium … even after auto-install: Executable doesn't exist at …/chromium_headless_shell-1254/…`. In the Conductor chat the cause is shown only some of the time.
- Running `playwright install chromium-headless-shell` by hand took 51 s on this host with no proxy. After that, web-kimi replied and kept multi-turn context, and web-deepseek returned a clear "Browser login needs renewal … conductor chat-web login deepseek".

## Suspected cause
The auto-install either does not run inside the worker-start budget (60 s) or its failure is reduced to WORKER_TIMEOUT. The "Failed to launch Chromium" error never reaches the Conductor chat.

## Related nit
`conductor chat-web runtime status` and `runtime stop` print a raw `Error: connect ENOENT …/runtime.sock` stack trace when no runtime is running. The changeset tells users to run `runtime stop` when they upgrade, so this case should print a one-line "no runtime running".

## Evidence
`claw/issues/tmp_release-qa-0180-20261109/` (local only): tasks `tmp_cw2_task` and `tmp_cw3_task`, plus the `tmp_cw_serve.log` runtime log in `/tmp/tmp_cw_serve.log`.

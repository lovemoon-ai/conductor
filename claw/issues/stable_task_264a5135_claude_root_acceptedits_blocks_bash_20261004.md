# stable: task 264a5135 — claude as root is downgraded to acceptEdits, so ssh/Bash and reads outside cwd are refused

- Task: `264a5135-52d5-4fee-93f3-6a18767040de` ("到beijing l20，评测一下vln_rvq_alldata_v13_hab4src_priornorm_hista…")
- Daemon: `roufo` (runs as **root**; shares `/mnt/data` with yy's `ruofo` box)
- Backend: claude (agent-SDK), resumed session `49afa3f8-0df7-4cc6-9928-4b96d713b0a3`, cwd `/mnt/data/yueyu/code/monorepo`
- Diagnosis type: snapshot. The task is `killed` (`daemon_disconnected`, 2026-09-29). `conductor diagnose` returns 404 for
  this task, so the evidence comes from the prod DB (`/opt/conductor/conductor.db`, read-only) and from the root daemon's
  per-project log `/mnt/data/yueyu/code/monorepo/conductor.log`. Prod `/opt/conductor/conductor.log` was rotated on the
  2026-10-04 deploy and has no lines for this task.
- Layer: **execution layer (claude permission policy)**. Routing, websocket and outbox are fine: every message was acked and answered.

## Conclusion

The claude session ran, but it could do nothing useful. Conductor saw the daemon was running as root and switched
claude from `bypassPermissions` to `acceptEdits`, because claude refuses bypass as root. Conductor still runs claude
headless with no `canUseTool` / permission-prompt handler. In `acceptEdits`, any tool call that would normally ask the
user is **denied automatically**:

- `Bash(ssh l20 ...)`, `rsync`: "the command needs approval, but this session is non-interactive, so it was denied"
- reading `/mnt/data/yueyu/experiments/...`: refused, because it is outside the session's working directory

So the 2026-08-30 fix (`claw/lessons/stable_claude-bypass-permissions-root-20260830.md`) turned "claude exits
immediately as root" into "claude starts but cannot run any command or read outside cwd". For agent work like
"把新的ckpt都提交评测" (ssh + rsync + reading the experiments dir), the result is the same: the task fails.

## Evidence

Root daemon log (`/mnt/data/yueyu/code/monorepo/conductor.log`, owned by `root`):

```
[conductor daemon 2026-09-25T12:08:35] Using backend: claude
[conductor daemon 2026-09-25T12:08:35] [claude] [agent-sdk] permission mode bypassPermissions -> acceptEdits (claude rejects bypassPermissions as root; set IS_SANDBOX=1 to keep it)
[conductor daemon 2026-09-25T12:08:40] Processing message 2bcbe4e1-... (user)
[conductor daemon 2026-09-25T12:09:13] claude reply (2bcbe4e1-...): I haven't submitted anything: this session is blocked ...
  - Local checkpoint folder: listing /mnt/data/yueyu/experiments/... was refused ... only allowed to read /mnt/data/yueyu/code/monorepo
  - ssh l20: the command needs approval, but this session is non-interactive, so it was denied.
```

Prod DB, `messages` for this task (UTC+8):

| time | role | content |
| --- | --- | --- |
| 09-25 11:54:01 | user | 把新的ckpt都提交评测 |
| 09-25 11:54:07 | sdk | 初始提示执行失败: Claude Code process terminated by signal SIGBUS |
| 09-25 11:55:37 | sdk | claude 处理失败: Claude Code process terminated by signal SIGBUS |
| 09-25 12:08:39 | user | 把新的ckpt都提交评测 (3rd attempt, after restart) |
| 09-25 12:09:14 | sdk | "I haven't submitted anything: this session is blocked …" (the permission denial above) |

`task_status_events`: one `killed / terminated by SIGTERM` at 09-25 12:07:57 (the manual restart between attempts 2 and 3).

Code path (main @ 1f11b7d):

- `modules/ai-sdk/src/providers/claude-agent-sdk-session.js`
  - `resolveClaudePermissionPolicy()`: when `isClaudeRootPermissionRestricted()` (uid 0, `IS_SANDBOX !== "1"`, no
    `CLAUDE_CODE_BUBBLEWRAP`), sets `permissionMode = acceptEdits` and `allowDangerouslySkipPermissions = false`.
  - `buildSdkOptions()` sets no `canUseTool` and no `permissionPromptToolName` by default
    (`grep -rn canUseTool modules/ai-sdk/src` finds nothing). Every "ask" decision in headless mode is therefore a deny.
- The PTY tool-preset path (`resolveClaudeCommandForRoot` in `cli/src/daemon.js`) has the same downgrade. It's less
  harmful there because a person at the terminal can approve prompts.

Scope check: in the last ~30 days, every `roufo` sdk message is from this task (6 sdk messages: 2 SIGBUS, 1 permission
denial). Every claude task on a root daemon without `IS_SANDBOX=1` will hit the same wall.

## Side finding: SIGBUS on the first two attempts

The first two turns (11:54, 11:55) died with `Claude Code process terminated by signal SIGBUS` before the permission
issue could show up. After the restart at 12:08 it went away. SIGBUS from the claude native binary usually means a
mapped file was truncated or replaced under it, for example the claude binary or the node_modules copy being updated in
place, or a mapped file on a flaky/full `/mnt/data` network mount. We can't confirm the cause from here. The root
daemon's own `~/.conductor/logs` on roufo is not readable from yy's box. To confirm: on roufo, check
`/root/.conductor/logs/*` around 2026-09-25 11:54 for an auto-update or claude reinstall, and check `dmesg` for
bus/IO errors on `/mnt/data`. This is unrelated to the root permission problem.

## Workaround now (user side, on roufo)

Choose one:

1. Run the roufo daemon as a regular user instead of root. This is the cleanest fix, and yy's `ruofo` box already does it.
2. Add `IS_SANDBOX: "1"` under `envs:` in roufo's `~/.conductor/config.yaml` and restart the daemon. Conductor then
   keeps `bypassPermissions` (log line disappears). This is Claude Code's own documented escape hatch for "root, but
   already isolated" environments (containers). It is a deliberate opt-out of claude's root safety check, so only do it
   on a box you accept treating as a sandbox.

## Fix direction (product side)

Implemented: the downgrade is removed and a chat warning is shown instead; see
`claw/lessons/stable_claude-root-acceptedits-silently-denies-tools-20261004.md`.

- **Make the failure visible instead of silent.** When the policy downgrades for root, emit a user-visible sdk
  message or warning on the task (not just a daemon log line), for example: "claude is running as root in acceptEdits
  mode: shell commands and reads outside the project will be refused. Run the daemon as a non-root user or set
  `envs.IS_SANDBOX=1`." The user here only learned this from claude's own reply text.
- **Warn at daemon startup / `conductor config` / `conductor diagnose`** when uid is 0 and claude is an allowed
  backend without `IS_SANDBOX`, because the setup is predictably broken for agent work.
- Do **not** silently re-create bypass behavior by auto-approving every tool through a `canUseTool` callback or by
  injecting `IS_SANDBOX=1` ourselves. That would just route around Claude Code's root safety gate on the user's
  behalf. Opting out should stay an explicit user setting.
- Update `claw/lessons/stable_claude-bypass-permissions-root-20260830.md`: "acceptEdits is the strongest mode claude
  allows as root" is true, but in a headless session with no permission handler, acceptEdits means no Bash and no reads
  outside cwd. That fix removed the crash but not the user-facing failure.

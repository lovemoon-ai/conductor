# stable: claude as root "worked" in acceptEdits but silently refused every shell command

- Date: 2026-10-04
- Severity: P1 (any root daemon: docker images, CI runners, bare VPS, shared GPU boxes)
- Component: `modules/ai-sdk/src/providers/claude-agent-sdk-session.js`, `cli/bin/conductor-fire.js`,
  `cli/src/daemon.js` (PTY tool-preset path), `cli/bin/conductor-config.js`
- Diagnosis: `claw/issues/stable_task_264a5135_claude_root_acceptedits_blocks_bash_20261004.md`
- Follows: `stable_claude-bypass-permissions-root-20260830.md` (which introduced the downgrade)

## Symptom

Task `264a5135` on root daemon `roufo` asked claude to submit checkpoints for evaluation. The session started
and claude replied, but it had done nothing:

> `ssh l20`: the command needs approval, but this session is non-interactive, so it was denied.
> listing `/mnt/data/yueyu/experiments/...` was refused … only allowed to read `/mnt/data/yueyu/code/monorepo`

The only trace on our side was a daemon log line nobody reads:
`permission mode bypassPermissions -> acceptEdits (claude rejects bypassPermissions as root; set IS_SANDBOX=1 to keep it)`.

## Root cause

The 2026-08-30 fix replaced "claude exits as root" with an automatic downgrade to `acceptEdits`.
`acceptEdits` only auto-approves file edits inside cwd. Everything else (Bash, reads outside cwd) needs approval.
Our SDK session sets no `canUseTool` / permission-prompt handler, so in a headless task every approval request is
an automatic deny. The downgrade swapped a loud failure for a quiet one: the session looked healthy but could not
run a single command. The PTY path and `conductor config` applied the same rewrite.

## Fix

- `resolveClaudePermissionPolicy()` no longer downgrades. The configured mode (default `bypassPermissions`) is
  used as-is. On root without `IS_SANDBOX=1` / `CLAUDE_CODE_BUBBLEWRAP` it reports `rootSandboxRequired: true`.
  A non-bypass mode the user chose still drops `allowDangerouslySkipPermissions` as root.
- The claude session puts a user-facing notice (`buildClaudeRootSandboxNotice()`, naming the real config path)
  on `getSnapshot().notices`. Fire's `reportBackendNotices()` posts it to the chat as a `severity: "warning"`,
  `synthetic` message right after "session started". The user sees the reason and the exact
  `envs: IS_SANDBOX: "1"` snippet before claude's turn fails.
- PTY tool-preset tasks keep the configured command. As root, `resolvePtyToolPresetCommand()` prefixes a
  `printf` of the same hint to stderr so it shows in the terminal. `buildPtyLaunchSpec()` also forwards
  `IS_SANDBOX` / `CLAUDE_CODE_BUBBLEWRAP` from config `envs:` into the claude PTY env, otherwise the advice
  would not fix terminal tasks (the PTY child only inherited the daemon env).
- `conductor config` always writes `claude --dangerously-skip-permissions`.
- Removed `resolveClaudeCommandForRoot()`. Added `claudeCommandNeedsRootSandbox()`.

## How to avoid next time

- **A fallback that silently strips capability is worse than a crash.** Before "falling back to the closest
  usable mode", check what that mode actually allows *in our runtime* (headless, no approver), not in an
  interactive terminal. `acceptEdits` without an approver is close to read-only for agent work.
- **If the user must act, tell them in the chat, not in the daemon log.** Users read the chat. Provider-level
  warnings go through `getSnapshot().notices` → fire's `reportBackendNotices()`.
- **Advice must actually work on every path it is shown on.** The hint says "set `envs.IS_SANDBOX`". That
  only held for the SDK path until the PTY env forwarded it. When a message tells the user to change config,
  trace that config key to every child process the message is shown for.
- **Don't route around a vendor's safety gate on the user's behalf.** Auto-injecting `IS_SANDBOX=1` or
  auto-approving everything with `canUseTool` would remove claude's root protection without the user knowing.
  The opt-out stays an explicit user setting, and we make it easy to find.

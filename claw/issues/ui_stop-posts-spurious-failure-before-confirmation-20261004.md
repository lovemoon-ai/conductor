# `/stop` posts a false failure message before "claude 已停止。"

- Severity: P2 (cosmetic / confusing; the stop itself works)
- Layer: final state (fire reply after an interrupted turn)
- Found by: release QA round 3, build `25dd30b` (local `main`), 2026-10-04

## Reproduction
1. Daemon `qa-dev-daemon` on `./bin/conductor-dev` @25dd30b, claude backend.
2. Start a turn that takes a long time, e.g. `Use the Bash tool (foreground) to run: python3 -c 'import time; time.sleep(200)'`.
3. While it runs, send `/stop` (web ⋯ → /stop, Esc in the composer, or `conductor task send <id> /stop`).

## Observed
The turn stops (2–12 s) and the command is killed. But before the confirmation the chat shows a failure line:
- stopping the **initial prompt** turn: `初始提示执行失败: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use`
- stopping a **later** turn: `claude 处理失败: Claude query ended without a result message`

Then `claude 已停止。` follows. Seen 4 times out of 4 (web menu, Esc, CLI; plus the same failure line on a 0.16.0 fire).
A `/stop` sent while no turn is running only gets `claude 已停止。` (correct).

## Expected
A user-requested stop only gets the confirmation. It should not show an "execution failed" error or internal diagnostics (`[ede_diagnostic] …`).

## Evidence
`claw/issues/tmp_release-0.17-qa-20261004/` (local, untracked): task c577bb84 message list, `tmp_evidence/st4_esc_textarea.*`, `st2_after_stop.*`.

## Note for the fixer
Users hit this in normal use, so write a lesson under `claw/lessons/` with the fix.

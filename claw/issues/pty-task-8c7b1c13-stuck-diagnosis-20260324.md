# PTY task 8c7b1c13-7fc3-4a80-932b-e807d7549b28 diagnosis (2026-03-24)

## Updated conclusion
- `source=live`
- This is still **not** a pending-user-message / outbox / websocket backlog issue.
- New host-side process evidence suggests the current PTY task may **not be hard-stuck**. Instead, the shell process is alive and appears to be **idly waiting for terminal input**.
- So the user-visible symptom is more likely: **PTY shell reached an input-waiting state, but the initial prompt / first screen was not observed by the client**, making the task look blank/stuck.

## Key evidence
### Diagnostics API
- `task.status=running`
- `task.agent_host=4090`
- `task.execution_host=4090`
- `realtime.bound_agent_host=4090`
- `realtime.bound_agent_connected=true`
- `messages.total_count=0`
- `messages.has_pending_user=false`
- `outbox.latest_for_pending_user=null`
- `diagnosis.code=no_pending_user`

### Host-side process inspection (`2026-03-24`)
For pid `555319`:
- `CMD=/bin/zsh -l`
- `STAT=SNs+`
- `WCHAN=do_poll.constprop.0`
- `TTY=pts/3`
- `pstree: systemd(1) -> MainThread(2113146) -> zsh(555319)`

### Interpretation of the process state
This is important:
- `do_poll.constprop.0` means the process is sleeping in `poll(2)` / waiting for fd activity.
- `TTY=pts/3` + foreground session leader (`s+`) is consistent with a shell attached to a PTY and **waiting for terminal input**.
- It is **not** showing an uninterruptible I/O wait (`D`) or a filesystem-blocked kernel wait signature.
- There is no extra child process under `zsh`; the shell itself is the active PTY foreground process.

## Revised interpretation
The strongest current interpretation is:
1. Daemon successfully created the PTY and launched `/bin/zsh -l`.
2. The shell is alive and currently waiting for user input.
3. The user sees a blank/stuck PTY because the initial prompt / first output likely was never rendered or replayed.

## Important correction
Earlier we used `pty_session.last_output_seq=0` as a hint. Code inspection shows this field is **not** updated on every live `terminal_output`; it is mainly updated on snapshot/exit paths. So `last_output_seq=0` on a running task does **not** prove the shell emitted zero bytes.

## Most likely failure domain now
More likely than a host process hang:
1. **initial prompt/output capture gap** in the PTY startup/attach path
2. **fresh attach snapshot is empty**, so the browser paints a blank terminal until more output arrives
3. less likely but possible: zsh startup emits no prompt text, then waits for input normally

## Why this matches the code path
In `cli/src/daemon.js`, the daemon:
1. creates the PTY via `createPtyFn(...)`
2. then stores the record and attaches `pty.onData(...)`

So there is a plausible race where a very fast shell prompt is emitted before the daemon's `onData` listener starts buffering output. If that happens, the shell ends up idle at prompt, but the client has no buffered snapshot to render and the PTY looks stuck/blank.

## About the previous PTY task being SIGKILLed
The previous task `a2c01c3e-...` required `SIGKILL` after `SIGTERM`. That is weaker evidence of a true hang than initially thought, because an interactive shell can ignore or not promptly honor `SIGTERM`. It still shows imperfect shutdown behavior, but does not by itself prove this current task is wedged.

## Best next verifications
1. In the app terminal for task `8c7...`, press `Enter` once.
   - If a prompt appears immediately, this strongly confirms the task was idle-at-prompt rather than hung.
2. Or from the host side, inject a newline into the PTY if operationally safe.
3. Check the task's `conductor-terminal.log`:
   - if empty, that supports the missed-initial-output theory
   - if it contains prompt text, then the loss is later in relay/attach/snapshot handling

## Recommended engineering follow-up
- Audit PTY startup ordering in `cli/src/daemon.js` around PTY creation vs `onData` listener attachment.
- Add an explicit startup snapshot or first-paint safeguard so a prompt emitted immediately after spawn cannot be lost.

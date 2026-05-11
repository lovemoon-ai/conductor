# ui: AI terminal stale attach recovery (2026-05-11)

## Symptoms
- Switching an AI task into Terminal view could show `terminal <taskId> is not attached`.
- After the terminal entered an error state, the Chat tab stayed disabled and the user could not return to the chat view.

## Root Cause
- The app gateway treated `terminal_detach` as an error when the app connection was not registered as a terminal viewer. Detach can arrive after an attach failure or before attach completes, so it must be idempotent.
- The terminal store treated stale `not attached` replies as terminal errors, leaving the task in a sticky error state.
- The AI task view toggle locked Chat for `error` and `exited` terminal states even though those states no longer own the session.

## Fix
- Made detached `terminal_detach` messages idempotent in the app gateway.
- Mapped stale `terminal <taskId> is not attached` errors back to an idle detached state so the mounted terminal can retry attach.
- Only lock the AI terminal view while the terminal is actively connecting or open.
- Added regression tests for stale detach handling, terminal cleanup before attach, and returning to Chat after terminal errors.

## Prevention
- Treat cleanup messages such as detach as idempotent across websocket reconnects and failed attach attempts.
- Do not use error states as UI locks unless the user has a clear escape path.
- Add tests around attach failure cleanup paths, not only the successful terminal-open path.

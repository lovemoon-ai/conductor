# Problem review: Copilot process status is not displayed, and occasional empty replies

## Symptoms
- When the app side task uses `copilot` backend, the status bar stays in `WAIT_READY` or no process state for a long time.
- In some tasks, Copilot clearly completed the reply locally, but the backend still reported `copilot did not return any text`.

## Root Cause
- `conductor-fire` previously enabled session-file reply stream only for `codex`. `copilot` still follows the old TUI text extraction path, which is prone to losing the final text in long task and tool execution scenarios.
- Copilot's status identification rules only cover the old style of `Thinking (Esc to cancel)`, but do not cover status lines such as `Running/Preparing ... (Esc to cancel)`.
- Copilot's completion judgment is too loose. It may be judged to be over when it sees any `assistant.turn_end`, and it will converge prematurely when encountering multiple turns (tool first, then final reply).
- The actual startup command parameters will overwrite the profile default parameters, resulting in `--alt-screen off` not taking effect, key status lines not entering scrollback, and status matching invalid.
- The session_started phase may still write `WAIT_READY` back to the runtime, causing the front-end display to be occupied by the old state.

## Fix
- Incorporate `copilot` into the session-file reply stream, and use the same path as `codex` to process incremental replies.
- Expand Copilot status matching rules and identify working status according to "prefix symbol + `Esc to cancel`".
- Rewrite Copilot completion judgment: a valid assistant message and corresponding completion mark are required, and a new turn in the middle will invalidate the old completion.
- Add a session checkpoint waiting window after `submit` to avoid fragile TUI extraction when the session file appears later.
- Merge profile default parameters and configuration parameters to ensure `--alt-screen off` takes effect.
- `WAIT_READY` is no longer reported to the front-end status bar in session-file mode.
## Prevention
- Uniformly adopt the "state source and text source are consistent" strategy for all backends to reduce mixed paths.
- Added profile parameter regression check to ensure that default parameters are not overwritten by configuration.
- Establish a fixed regression use case for multiple turns (tool turn + final turn) to prevent the completion judgment from falling back to "the first turn_end is completed".
- After each CLI/TUI upgrade, play back a set of real log samples to verify that the status line and completion mark can still be recognized by the current rules.
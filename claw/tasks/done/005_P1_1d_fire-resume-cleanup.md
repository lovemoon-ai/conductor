# Goal

Implement a cleanup pass for `conductor fire --resume` so it restores only the backend session and moves provider-specific resume logic into `ai-sdk`.
## Inputs
1. Code path: `cli/bin/conductor-fire.js`, `cli/src/fire/resume.js`, `modules/ai-sdk/src/`
2. Current implementation: Codex has restored the session through `codex app-server thread/resume` inside `ai-sdk`
3. Current status: `fire` still parses provider session path/cwd by itself, and retains the message drain/backfill branch of the old task recovery era
## Non-goals
1. Do not restore the old Conductor task
2. Do not modify the task/message main protocol of Conductor server
3. Do not rewrite the resume token format of all providers in this issue.
## Steps
1. Add a unified resume entry in `ai-sdk`
   - Provide interfaces similar to `resolveResume()` / `inspectResumeTarget()`
   - Return standardized results: `provider`, `sessionId`, `cwd`, `sessionPath/debugMetadata`
   - Move the session discovery logic of Codex / Claude / Copilot from `fire` to provider adapter or ai-sdk resume resolver
2. Shrink `fire --resume` to controller responsibility
   - `fire` only parses CLI parameters and calls `ai-sdk`'s resume resolver
   - `fire` only does `process.chdir(cwd)`, creates a new task, and creates a backend session
   - Delete `fire`'s internal direct knowledge of `~/.codex`, `~/.claude`, `~/.copilot` path structures
3. Delete old tasks and restore the remaining ones
   - Delete the logic of `getLocalTaskRecord()` automatically getting the old bound session
   - Delete `resumeMode + drainBufferedMessagesForResume()` to start the logic of skipping old messages
   - Delete the `resumeMode` special branch in `backfillPendingUserMessages()`
   - Delete the `resumeMode` state that only exists for the above logic or shrink it to a pure log field
4. Supplement testing and redefine acceptance semantics
   - `fire --resume <id>` will create a new task and restore the existing backend session
   - When `--resume` is not passed, sessions will no longer be automatically stolen from the old task binding.
   - `fire` no longer tests provider-specific session path parsing, and related tests are migrated to `ai-sdk`
   - Codex real machine verification: If you have a persistent session, you can resume it through app-server and continue the conversation in a new task.
## Rules
1. The provider semantics of `resume` must be provided by `ai-sdk`, and `fire` is no longer directly implemented.
2. `fire` only retains controller responsibilities: task, cwd, message forwarding, session binding
3. When deleting the old task and restoring the remaining ones, it cannot affect the normal message recovery in the disconnection and reconnection scenario.
## Implementation points
1. The provider logic related to `findSessionPath()` in `cli/src/fire/resume.js` should be moved to `modules/ai-sdk`
2. `fire` only accepts a standardized resume context returned by ai-sdk during the startup phase.
3. Two types of recovery need to be distinguished:
   - `fire --resume`: new task + old backend session
   - reconnect recovery: connection recovery for the same task, not equal to `--resume`
## Acceptance criteria
1. `conductor fire --resume <session-id>` only restores the backend session and binds it to the newly created task
2. `fire` source code no longer contains provider-specific session path discovery logic
3. No longer drain/skip historical messages due to "old task recovery" during startup
4. `ai-sdk` side test covers resume resolver and provider-specific recovery logic
## Risks and rollback
1. Risk: After removing the `fire` side path parsing, the resume entry of some providers is temporarily incomplete.
2. Rollback: Keep the old implementation branch in a separate commit, and roll back according to the provider if necessary
## Done
Complete and verify the `fire --resume` cleanup, including removal of old-task recovery residue and migration of provider-specific resume logic into `ai-sdk`.
Do not stop until the done condition is satisfied.
# Goal

Implement "`resume.js`'s provider-specific resume parsing and session discovery logic sinking into `ai-sdk`, `conductor fire` only retains controller responsibilities"
## Inputs
1. Code path: `cli/bin/conductor-fire.js`, `cli/src/fire/resume.js`, `modules/ai-sdk/src/`
2. Current implementation: `conductor fire --resume <id>` still parses provider session path / cwd inside CLI first, and then passes `resumeSessionId` to `ai-sdk`
3. Current target: The main resume protocol inside the Conductor should be interpreted by the provider adapte
   - `fire` no longer directly understands the `~/.codex`, `~/.claude`, `~/.copilot` directory structure.
## Non-goals
1. Do not restore the old `--from`/history loader path
2. Do not modify the task/message main protocol of Conductor server
3. Do not rewrite the resume token format of all providers in this issue.
## Steps
1. Codemap understands the current resume link and only looks at `conductor-fire`, `modules/ai-sdk`, provider adapter
2. Add a unified resume resolver in `ai-sdk`
   - Provide standardized entrance, such as `inspectResumeTarget()` / `resolveResumeContext()`
   - Return to the unified structure: `provider`, `sessionId`, `cwd`, `sessionPath`, `debugMetadata`
   - Move the session discovery logic of Codex / Claude / Copilot to `ai-sdk`
3. Shrink `conductor-fire`
   - `fire` only parses CLI parameters and calls `ai-sdk`'s resume resolver
   - `fire` only does `process.chdir(cwd)`, creates tasks, and starts backend sessions.
   - Delete `fire`'s internal direct knowledge of provider-specific session path
4. Adjust the test
   - `cli` only retains controller-level resume tests
   - provider-specific resume resolver test migration to `ai-sdk`
   - Codex app-server resume path supplements end-to-end testing
## Rules
1. `resume_token` must remain opaque and interpreted by the provider adapter itself
2. `manualResume` and internal `resume_token` continue to be modeled separately
3. `fire` no longer directly parses provider session files or home directory layouts
## Implementation points
1. `findSessionPath()`, `findCodexSessionPath()`, `findClaudeSessionPath()`, `findCopilotSessionPath()`, `resolveResumeContext()` in `resume.js` should be moved to `modules/ai-sdk`
2. `fire` only accepts one standardized resume context returned by `ai-sdk` during the startup phase.
3. reconnect recovery is still a connection recovery belonging to the same task, which is not equivalent to `fire --resume`
## Acceptance criteria
1. `conductor fire --resume <session-id>` can still restore the existing backend session and bind it to the new task
2. `cli/bin/conductor-fire.js` no longer directly import provider-specific resume helper
3. `cli/src/fire/resume.js` was removed or shrunk into a pure CLI parameter-compatible shell
4. `ai-sdk` side test covers resume resolver and provider-specific recovery logic
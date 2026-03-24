# 0018 AI SDK Support for Kimi CLI

## Status

Proposed

## Owner

TBD

## Date

2026-03-23

## Summary

Add a new `kimi` backend to `modules/ai-sdk` by following the existing `RemoteAiSession -> worker -> provider session -> transport -> local AI tool` architecture. The initial implementation uses Kimi CLI Wire mode instead of PTY scraping or print-mode parsing, keeps `fire-controller` provider-agnostic, and reuses the existing worker isolation model. The first version targets unattended Conductor tasks, so the Kimi runtime runs in YOLO mode and fails fast on any unexpected interactive request.

## Context

- `ai-sdk` already exposes one stable boundary to `fire`: `createAiSession(backend, options)`.
- The current extension point is `session-factory.js`, which normalizes backend names and instantiates one provider session per backend.
- Each provider session is responsible for:
  - session boot and resume
  - turn lifecycle
  - mapping provider-native events into `session`, `assistant_message`, `working_status`, `auth_required`, and `process.exited`
- Each transport is responsible for:
  - spawning the local runtime
  - protocol framing
  - stderr and process-exit handling

The current architecture fits Kimi well, but only if we integrate Kimi at the provider/transport layer instead of adding a new PTY-special case in `cli/fire`.

Kimi CLI currently exposes multiple integration modes:

- `--print` for simple non-interactive automation
- `--wire` for structured JSON-RPC communication over stdin/stdout
- `--session` to resume a specific session, and create it if it does not already exist
- `--work-dir` to bind the session to a workspace
- `--yolo` to auto-approve operations

That means Kimi can fit the existing `ai-sdk` model without introducing TUI scraping, session-file polling, or `fire`-side provider orchestration.

## Goals

- Add `kimi` as a first-class `ai-sdk` backend.
- Keep `fire-controller` unaware of Kimi CLI protocol details.
- Reuse the existing worker isolation boundary.
- Provide stable Kimi session identity and resume behavior.
- Map Kimi Wire events into the same Conductor-facing session event surface already used by the other backends.
- Make daemon capability advertisement and app backend selection work with minimal web changes.

## Non-Goals

- Do not add a new generic provider abstraction beyond the current `session-factory -> provider session -> transport` split.
- Do not implement Kimi tool approval UI in this RFC.
- Do not add external tool registration for Kimi Wire mode in this RFC.
- Do not require `conductor fire --resume <id>` to recover a Kimi workspace from local disk scanning in v1.
- Do not switch to `kimi-agent` Rust runtime in the first rollout.

## Options Considered

### Option A: Kimi print mode via `kimi --print --output-format=stream-json`

- Pros:
  - Smallest transport surface.
  - Easy to prototype.
- Cons:
  - Poor match for the current `ai-sdk` contract.
  - No structured `cancel` path.
  - Weak lifecycle signals compared with Codex app-server and Opencode server.
  - Harder to distinguish thinking, tool calls, compaction, and turn completion.
  - Harder to support future interactive features without rewriting the integration.

### Option B: Kimi Wire mode via `kimi --wire`

- Pros:
  - Best fit for the current provider/transport architecture.
  - Official structured JSON-RPC protocol with `initialize`, `prompt`, `cancel`, `replay`, event notifications, and request messages.
  - Gives the provider adapter enough information to emit `working_status` and `assistant_message` events without PTY parsing.
  - Keeps future room for approval and question handling.
- Cons:
  - Wire mode is still marked experimental upstream.
  - Requires explicit request-handling policy to avoid deadlocks.

### Option C: Kimi Agent Rust runtime (`kimi-agent`)

- Pros:
  - Smaller footprint and faster startup.
  - Same Wire protocol shape.
- Cons:
  - Separate release train from the main Kimi CLI.
  - No Kimi account login flow.
  - Provider support is intentionally narrower.
  - Adds rollout risk with little user-facing benefit in the first implementation.

## Proposed Design

### 1. New ai-sdk provider path

Add a new provider path:

```text
RemoteAiSession
-> worker
-> KimiCliSession
-> KimiWireTransport
-> kimi --wire
```

New files:

- `modules/ai-sdk/src/providers/kimi-cli-session.js`
- `modules/ai-sdk/src/transports/kimi-wire-transport.js`

Updated files:

- `modules/ai-sdk/src/session-factory.js`
- `modules/ai-sdk/src/client.js`
- `modules/ai-sdk/src/worker.js` if only small event-forwarding adjustments are needed
- `modules/ai-sdk/src/shared.js` only if a shared JSON-RPC helper is worth extracting

Provider variant name:

- backend: `kimi`
- provider variant: `kimi-cli-wire`

### 2. Backend normalization and public boundary

`session-factory.js` will:

- accept `kimi`
- normalize aliases like `kimi-cli` and `kimi-code` to `kimi`
- return `kimi-cli-wire` from `providerVariantForBackend()`
- instantiate `KimiCliSession`
- update the unsupported-backend error text to include Kimi

The public `createAiSession()` boundary remains unchanged.

### 3. Transport design

`KimiWireTransport` will be a JSON-RPC transport similar in shape to `CodexAppServerTransport`, but targeting Kimi Wire mode.

Default command resolution order:

1. `CONDUCTOR_KIMI_COMMAND`
2. `options.commandLine`
3. `CONDUCTOR_CLI_COMMAND`
4. `kimi`

The transport will spawn Kimi with:

- `--wire`
- `--yolo`
- `--work-dir <cwd>`
- `--session <sessionId>`
- optional `--model <model>`
- optional `--config-file <path>`

We intentionally do not use `--continue` in `ai-sdk`.

Reason:

- Kimi documents that `--session <id>` resumes a session with that ID and creates it if it does not exist.
- That lets Conductor own session identity at the `ai-sdk` boundary instead of discovering it after first turn.
- This is cleaner than provider-assigned session IDs and fits the current architecture better.

Transport responsibilities:

- spawn and supervise the Kimi child process
- send `initialize`
- verify compatible Wire protocol version
- expose request helpers for `prompt`, `cancel`, and optionally `replay`
- forward `event` notifications
- forward `request` messages to the provider session
- capture stderr tail for diagnostics
- reject pending requests on process exit

Initial `initialize` payload:

```json
{
  "protocol_version": "1.5",
  "client": {
    "name": "conductor-ai-sdk",
    "version": "0.0.0"
  },
  "capabilities": {
    "supports_question": false,
    "supports_plan_mode": false
  }
}
```

Rationale:

- `supports_question: false` hides Kimi's `AskUserQuestion` tool.
- `supports_plan_mode: false` avoids plan-mode-specific client requirements.
- no `external_tools` are registered in v1.

### 4. Provider session design

`KimiCliSession` will mirror the current provider-session style used by `ClaudeAgentSdkSession` and `OpencodeSdkSession`.

Core state:

- `cwd`
- `sessionId`
- `resumeSessionId`
- `sessionInfo`
- `currentTurn`
- `lastReplyTarget`
- `lastTokenUsage`
- `lastContextUsagePercent`
- `closeRequested`
- `bootPromise`

Session identity rules:

- If `options.resumeSessionId` exists, reuse it.
- Otherwise generate a fresh session ID inside `KimiCliSession` before transport boot.
- Always pass that ID to Kimi with `--session`.

This gives us:

- `ensureSessionInfo()` without disk discovery
- consistent `manualResume`
- clean Conductor task/session binding from the first turn

`getSnapshot()` will expose:

- `backend: "kimi"`
- `provider: "kimi-cli-wire"`
- `cwd`
- `sessionId`
- `sessionInfo`
- `useSessionFileReplyStream: true`
- `resumeReady: true`
- `manualResume.command: "kimi --work-dir <cwd> --session <id>"`
- `pid`

`getSessionUsageSummary()` will initially expose:

- `sessionId`
- `contextUsagePercent` from Wire `StatusUpdate.context_usage`
- `tokenUsage` from Wire `StatusUpdate.token_usage`
- `manualResume`

It will not block rollout on cost reporting, because Kimi Wire docs do not guarantee a cost field in the event schema.

### 5. Event mapping

Kimi Wire events will be mapped into the existing `ai-sdk` surface.

Mapping plan:

- `TurnBegin`
  - emit `working_status`
  - phase: `turn_started`
  - status line: `kimi is working`
- `StepBegin`
  - emit `working_status`
  - phase: `reasoning`
  - status line: `kimi reasoning`
- `CompactionBegin`
  - emit `working_status`
  - phase: `context_compaction`
  - status line: `kimi compacting context`
- `CompactionEnd`
  - keep state only, no special terminal event required
- `StatusUpdate`
  - update cached context/token usage
  - emit `working_status` with phase `reasoning` unless a stronger phase is active
- `ContentPart` with `type: "think"`
  - emit `working_status`
  - phase: `reasoning`
- `ContentPart` with `type: "text"`
  - accumulate assistant text
  - emit `working_status` with phase `message_aggregation`
  - emit final `assistant_message` once the turn completes
- `ToolCall`
  - map by tool name to `command_execution`, `file_update`, `workspace_inspection`, `web_lookup`, or `tool_call`
- `ToolResult`
  - keep phase active and optionally enrich `status_done_line`
- `SubagentEvent`
  - map to `task_progress` in v1
- `TurnEnd` or successful `prompt` response
  - finalize assistant text
  - emit `working_status` with phase `turn_completed`
- `prompt` result with `status: "cancelled"`
  - emit `working_status` with phase `turn_cancelled`
- transport or RPC error
  - emit `working_status` with phase `turn_failed`
  - surface `auth_required` if the error indicates login or provider configuration failure

This keeps the public event vocabulary unchanged while preserving enough Kimi detail for the existing Conductor runtime-status UI.

### 6. Interactive request policy

Kimi Wire can send `ApprovalRequest`, `ToolCallRequest`, and `QuestionRequest`.

In v1:

- `--yolo` is always enabled, so normal file and shell approvals should not block the turn.
- `supports_question: false` hides question tools.
- no external tools are registered, so `ToolCallRequest` should never appear.

If a request still arrives, `KimiCliSession` should fail fast with a clear provider error such as:

- `reason: "unexpected_interactive_request"`
- `message: "Kimi CLI requested interactive approval in unattended Conductor mode"`

This is preferable to silent deadlock inside the worker.

### 7. Interrupt and close behavior

Kimi Wire provides `cancel`.

`KimiCliSession` will:

- call transport `cancel` when the worker is closing during an active turn
- call transport `cancel` when turn deadline is exceeded
- treat `No agent turn is in progress` as best-effort success during shutdown

This matches the current worker isolation rules better than killing the child process first.

### 8. CLI and runtime integration

The `ai-sdk` change alone is not enough; `cli` must advertise and launch the backend.

Required CLI changes:

- `cli/src/runtime-backends.js`
  - add `kimi` to `RUNTIME_SUPPORTED_BACKENDS`
- `cli/bin/conductor-fire.js`
  - include `kimi` in backend help and examples
  - generalize `resolveAiSessionCommandLine()` so `allow_cli_list.kimi` can be forwarded into `ai-sdk`
  - continue passing `commandLine` through `createAiSession()`
- `cli/src/fire/resume.js`
  - v1 does not promise generic local `--resume` workspace discovery for Kimi
  - if we choose to expose `buildResumeArgsForBackend("kimi")`, it should be `["--session", id]`, but CLI-side workspace recovery remains deferred

The daemon and web stack are already mostly backend-agnostic:

- daemon capability advertisement is driven by `allow_cli_list`
- task ingress and UI backend selectors already consume `supportedBackends`

That means the web package should only need small test updates unless we want Kimi-specific labels or docs.

## Risks

- Wire mode is upstream-experimental, so protocol drift is the main compatibility risk.
- Unexpected Kimi `request` messages could stall unattended turns if not handled explicitly.
- Kimi session identity is tied to workspace, so manual resume commands must include `--work-dir`.
- Kimi usage reporting may be less complete than Codex or Opencode in the first release.
- `conductor fire --resume <id>` for arbitrary local Kimi sessions remains unresolved in v1.

## Rollout

### Phase 0: ai-sdk-only spike

- Add `KimiWireTransport`
- Add `KimiCliSession`
- Add client boundary tests
- Add transport fixture tests with fake JSON-RPC stdout

### Phase 1: end-to-end backend support

- Add `kimi` to runtime-supported backends
- Forward `allow_cli_list.kimi` into `ai-sdk`
- Add fire tests for backend resolution and startup
- Verify daemon advertises `supportedBackends: ["kimi"]`

### Phase 2: hardening

- Add auth-failure fixtures
- Add cancel/timeout tests
- Add unexpected-request tests
- Decide whether CLI-side `--resume` workspace discovery is needed

Backward compatibility notes:

- Existing backends keep their current behavior.
- No public `ai-sdk` entrypoint changes are required.
- The new backend is opt-in through `allow_cli_list.kimi`.

## Acceptance

- `createAiSession("kimi", options)` returns a working `RemoteAiSession`.
- `session.getSnapshot().provider === "kimi-cli-wire"`.
- `ensureSessionInfo()` returns a stable session ID before or at first turn.
- `runTurn()` streams `working_status` updates and emits a final `assistant_message`.
- Kimi turn cancellation on close or timeout does not leave the worker hung.
- `allow_cli_list.kimi` causes daemon capability advertisement to include `kimi`.
- App task creation can target a daemon that only supports `kimi` without any hardcoded backend map.
- Unexpected interactive Kimi requests fail with a clear error instead of hanging the worker.

## Open Questions

- Do we want to guarantee standalone `conductor fire --backend kimi --resume <id>` in the first iteration, or only task-scoped resume where Conductor already knows the workspace?
- Should `sessionId` default to a generated UUID, or should `fire` pass task ID into `ai-sdk` so provider session IDs are traceable to Conductor tasks?
- Do we want to flatten `SubagentEvent` recursively for richer runtime-status reporting, or keep it as coarse `task_progress` in v1?
- Should we accept older Wire protocol versions, or require the current documented `1.5` explicitly?

## References

- Internal architecture: `claw/architecture/ai-sdk.md`
- Internal RFC baseline: `claw/rfc/0017-refactor-ai-sdk.md`
- Kimi Wire mode docs: https://moonshotai.github.io/kimi-cli/en/customization/wire-mode.html
- Kimi command reference: https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html
- Kimi sessions guide: https://moonshotai.github.io/kimi-cli/en/guides/sessions.html
- Kimi data locations: https://moonshotai.github.io/kimi-cli/en/configuration/data-locations.html

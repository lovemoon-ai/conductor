# AI SDK reconstruction design draft
Date:2026-03-08
## background
In the current task execution link, `fire` also assumes four types of responsibilities:
- Communicate with Conductor server
- Maintenance task messages and ack
- Orchestrate local AI sessions
- Handle provider details and exception recovery
turn out:
- provider details leaked directly to `fire`
- `fire` directly relies on `tui-driver`, session file, history loader and other implementation details
- The success of a turn often requires reference to multiple sources at the same time
- The local instability of any provider will amplify into unstable connection of the entire task.
Under the stability requirements, the current structure fails.
## Target
There is only one goal for this reconstruction:
- Completely isolate "remote task connection stability" and "local AI tool access complexity".
Specific goals:
- `cli/fire` only relies on two levels of abstraction, `conductor-sdk` and `ai-sdk`.
- `cli` no longer directly imports `tui-driver`, provider profile, session file parser.
- `ai-sdk` exposes a unified interface to all providers.
- Each provider decides its own internal implementation, but `fire` is not aware of it.
- For each provider, for each turn, a single source of authority must be defined.
- `resume`, status, errors, and system information are all exposed through a unified schema.
## non-target
This article explicitly does not do the following things:
- Not compatible with existing `fire` internal structure.
- There is no guarantee that `cli2sdk` will remain in the main path.
- All providers are not required to be implemented the same way.
- `daemon` is not required to continue to participate in turn-level logic.
## Current link disassembly
### Current real link
Now from web app to local AI session, it is roughly:
1. `web app`
2. `web server`
3. `daemon`
4. `fire`
5. `fire` internal provider orchestration6. `tui-driver` / session file / history loader / CLI parameter assembly7. Native AI Tools
### Problems with the current link
The problem is not the large number of links, but the misalignment of responsibility boundaries:
- The boundary between `daemon` and `fire` is unclear
- `fire` is both a controller and a provider adapter-The provider adapter is directly coupled with the underlying transport
- The input, output, and completion judgment of the same turn come from multiple sources
This results in:
- If the session fails, it will misjudge the turn failure.
- Local instability of the provider will interrupt the entire task
- The cost of accessing new providers is getting higher and higher
## Which links are necessary?
Necessary links to retain after reconstruction:
1. `web app`
2. `web server`
3. `fire-controller`
4. `ai-runtime`
5. `provider adapter`
6. `provider transport`
7. Native AI Tools
The key changes here are:
- `fire-controller` and `ai-runtime` separate
- `fire-controller` and `ai-runtime` separate
## Which links can be removed?
Things that can be removed from the main path:
- `daemon` participates in turn-level logic
- `fire` directly import `tui-driver`
- `fire` directly parses session file
- `fire` directly spells provider resume parameter
- `fire` directly maintains provider-specific health logic
- `cli2sdk` This main path is based on complete history spelled prompt
- The split-brain mode of "take one link for input, another link for output, and then look at the third link after completing the judgment"
## Overall architecture
Target architecture:
1. `conductor-sdk`
2. `fire-controller`
3. `ai-sdk client`
4. `ai-runtime worker`
5. `provider adapter`
6. `provider transport`
7. local AI tool

### Responsibilities of each layer
`conductor-sdk`：

- Communicate with web server
- Task creation, message collection, message ack, runtime status reporting
`fire-controller`：

- Only handles the mission control surface
- Hold `AiSessionClient`
- Translate `ai-sdk` events into Conductor messages and runtime status
- Does not handle provider details
`ai-sdk client`：

- Provide a unified session interface for `fire-controller`
- Control `ai-runtime worker` via local RPC
`ai-runtime worker`：

- independent process
- Responsible for session life cycle
- Responsible for worker-level recovery, timeouts, and health checks
- Responsible for calling specific provider adapter
`provider adapter`：

- Responsible for provider-specific semantics
- Unify the underlying events into `AiSessionEvent`
- Determine resume token and state semantics
`provider transport`：

- Responsible for the lowest level docking method
- For example app-server, session file, tui-driver, native CLI
## Why must `ai-runtime worker` be introduced?
If `ai-sdk` were just an in-process library, stability issues would still exist.
reason:
- `tui-driver` crash will directly kill `fire`
- The abnormal exit of the provider child process will pollute the controller state
- File monitoring, PTY, and protocol parsing are all high-risk codes
Therefore it is recommended:
- `fire-controller` only guarantees remote connection
- `ai-runtime worker` separate process takes over local complexity
Benefits of doing this:
- Local session crash does not mean task connection disconnection
- `fire-controller` can decide to restart the worker or report failure
- Provider access and controller decoupling
## Module boundaries
Suggested new modules:
```text
modules/ai-sdk/
  src/client/
  src/rpc/
  src/runtime/
  src/providers/
  src/transports/
  src/types/
  src/bin/ai-runtime.ts
```

Suggested division of responsibilities:
`modules/ai-sdk/src/client`：

- API exposed to `fire-controller`
`modules/ai-sdk/src/rpc`：

- Native protocol between client and runtime
`modules/ai-sdk/src/runtime`：

- worker main loop- session manager
- restart policy

`modules/ai-sdk/src/providers`：

- `codex-appserver`
- `codex-tui`
- `claude-sessionfile`
- `claude-tui`
- `copilot-sessionstate`
- `copilot-tui`

`modules/ai-sdk/src/transports`：

- `app-server`
- `session-file`
- `tui-driver`
- `child-process`

### Location of old modules
`modules/tui-driver`：

- No longer directly dependent on `cli`
- Only allowed to be used by `modules/ai-sdk` internal transport
`modules/cli2sdk`：

- No longer enter the task main path
- Can be kept as an experimental tool or archived later
## Boundary of responsibilities between Fire and Daemon
### daemon

`daemon` only retains:
- The fire process is started-Task level supervisor
- Machine level status reporting
`daemon` is no longer responsible for:
- provider parameter- provider resume
- turn status- provider health logic
### fire-controller

`daemon` only retains:
- Conductor task attach
- pull messages- idempotent and ack- runtime status aggregation
- AI session life cycle control
`daemon` is no longer responsible for:
- provider command assembly
- PTY life cycle- session file reading- provider-specific state machine
## AI SDK external interface
### Top-level interface
```ts
export interface AiSdk {
  openSession(options: OpenSessionOptions): Promise<AiSession>;
}

export interface AiSession {
  getSessionId(): string;
  subscribe(listener: (event: AiSessionEvent) => void): () => void;
  sendTurn(input: AiTurnInput): Promise<AiTurnReceipt>;
  interruptTurn(turnId: string): Promise<void>;
  resume(options?: ResumeOptions): Promise<void>;
  getSnapshot(): Promise<AiSessionSnapshot>;
  close(reason?: string): Promise<void>;
}
```

### `OpenSessionOptions`

```ts
export interface OpenSessionOptions {
  provider: AiProviderName;
  providerVariant?: string;
  workspace: string;
  model?: string;
  env?: Record<string, string>;
  resumeToken?: string;
  metadata?: Record<string, unknown>;
}
```

### `AiTurnInput`

```ts
export interface AiTurnInput {
  turnId: string;
  replyTo?: string;
  text: string;
  attachments?: AiAttachment[];
}
```

### `AiTurnReceipt`

```ts
export interface AiTurnReceipt {
  turnId: string;
  providerTurnId?: string;
  acceptedAt: string;
}
```

## Snapshot definition
When `fire-controller` reads the session status, you should not see the internal details of the provider, only the unified snapshot.
```ts
export interface AiSessionSnapshot {
  sessionId: string;
  provider: AiProviderName;
  providerVariant: string;
  state: AiSessionState;
  workspace: string;
  model?: string;
  pid?: number;
  resumeToken?: string;
  resumeReady: boolean;
  manualResume?: AiManualResumeInfo;
  authState: AiAuthState;
  networkState: AiNetworkState;
  tokenUsagePercent?: number;
  contextUsagePercent?: number;
  lastError?: AiErrorInfo;
  debug?: Record<string, unknown>;
}
```

Note here:
- `resumeToken` is an opaque token
- `fire-controller` should not know what this token represents for different providers.
- Manual CLI resume parameters must be exposed through separate fields and cannot be mixed with `resumeToken`
```ts
export interface AiManualResumeInfo {
  supported: boolean;
  ready: boolean;
  command?: string;
  args?: string[];
  displayText?: string;
  note?: string;
}
```

## Event definition
Unified event flow:
```ts
export type AiSessionEvent =
  | SessionOpenedEvent
  | SessionResumedEvent
  | SessionUpdatedEvent
  | TurnAcceptedEvent
  | TurnStatusEvent
  | TurnOutputDeltaEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | WarningEvent
  | AuthRequiredEvent
  | ProcessExitedEvent;
```

Suggested minimum set of events:
```ts
type SessionOpenedEvent = {
  type: "session.opened";
  sessionId: string;
  snapshot: AiSessionSnapshot;
};

type SessionResumedEvent = {
  type: "session.resumed";
  sessionId: string;
  snapshot: AiSessionSnapshot;
};

type SessionUpdatedEvent = {
  type: "session.updated";
  sessionId: string;
  snapshot: AiSessionSnapshot;
};

type TurnAcceptedEvent = {
  type: "turn.accepted";
  sessionId: string;
  turnId: string;
  providerTurnId?: string;
};

type TurnStatusEvent = {
  type: "turn.status";
  sessionId: string;
  turnId: string;
  phase: "queued" | "running" | "reasoning" | "tool" | "finalizing";
  message?: string;
};

type TurnOutputDeltaEvent = {
  type: "turn.output.delta";
  sessionId: string;
  turnId: string;
  delta: string;
};

type TurnCompletedEvent = {
  type: "turn.completed";
  sessionId: string;
  turnId: string;
  outputText: string;
  usage?: AiUsageSummary;
};

type TurnFailedEvent = {
  type: "turn.failed";
  sessionId: string;
  turnId: string;
  error: AiErrorInfo;
};
```

### Event design principles
Design principles:
- `fire-controller` only consumes events and does not deduce provider behavior- runtime status must be directly mapped by these events
- `turn.completed` and `turn.failed` must be mutually exclusive
- `turn.output.delta` can only come from a single authoritative source
## Error model
Unified error code:
```ts
export type AiErrorCode =
  | "auth_required"
  | "rate_limited"
  | "network_unavailable"
  | "resume_not_found"
  | "provider_exited"
  | "turn_timeout"
  | "protocol_error"
  | "unsupported"
  | "internal_error";
```

```ts
export interface AiErrorInfo {
  code: AiErrorCode;
  message: string;
  retryable: boolean;
  fatal: boolean;
  raw?: Record<string, unknown>;
}
```

After unifying the errors, the processing of `fire-controller` will be very simple:
- `retryable = false` reports errors directly
- `retryable = true` can be left to the worker to recover by itself, or enter the controller level and try again
## State machine
### Session state machine
```text
new
-> starting
-> ready
-> busy
-> degraded
-> closing
-> closed

fatal error -> failed
```

definition:
- `new`: The session object has just been created
- `starting`: Start provider process / establish protocol
- `ready`: Acceptable turn
- `busy`: There is a turn running
- `degraded`: The process is still alive or recoverable, but the current state is unstable
- `closing`: External request closed
- `closed`: has been shut down normally
- `failed`: Unrecoverable failure
### Turn state machine
```text
queued
-> accepted
-> running
-> streaming
-> completed

running -> waiting_tool -> running
running -> failed
running -> interrupted
running -> lost
```

definition:
- `queued`: turn has been received, the request has not yet been sent to the bottom layer
- `accepted`:provider has accepted the turn
- `running`: Executing
- `streaming`: Has entered the assistant output stage
- `waiting_tool`: Waiting for tool or command execution
- `completed`: Successfully completed
- `failed`: clear failure
- `interrupted`: Interrupt actively
- `lost`: The provider process exited abnormally, and the current turn status cannot be confirmed.
## Provider layering
### Layering principle
Every provider adapter must know the following five things:
1. Session binding authoritative source2. turn authoritative source of life cycle3. Assistant outputs authoritative sources4. usage statistics source5. resume token semantics
prohibit:
- session from A- turn complete from B
- Final reply from C- fire makes a second inference by itself
### ProviderVariant Design
Do not mix different implementations under the same provider name and automatically switch between them.
Recommend explicit variant:
- `codex-appserver`
- `codex-tui`
- `claude-sessionfile`
- `claude-tui`
- `copilot-sessionstate`
- `copilot-tui`

reason:
- Different implementations have different stability and semantics
- Should not switch secretly at runtime
- Once switched, the resume token and status definition will change
## Recommended strategies for each Provider
### Codex

Default production variant:
- `codex-appserver`

Authoritative source:
- session：`thread.id`
- turn life cycle: `turn/start` + `turn/completed`
- Output:`item/agentMessage/delta`- usage:`thread/tokenUsage/updated` and `account/rateLimits/updated`- resume：`thread/resume(threadId)`

Additional information:
- Conductor internal `resume_token` is defined and interpreted by the provider adapter itself
- `codex resume <threadId>` is only available as an external manual diagnostic capability
- Manual CLI resume parameters should be exposed separately via `manualResume`
- Not used as Conductor internal master resume protocol
- `codex-tui` can be retained, but only as an explicit debug variant
### Claude

It is recommended to define two variants:
- `claude-sessionfile`
- `claude-tui`

By default, only one path is selected for production, and automatic dual path mixing is not performed.
If `claude-sessionfile` becomes the default:
- session:session file session id- turn life cycle: session file append event
- Output: session file append event- resume：provider native resume token

If `claude-sessionfile` becomes the default:
- All with TUI transport as the single authority
### Copilot

Two variants are also recommended:
- `copilot-sessionstate`
- `copilot-tui`

The principles are the same as Claude:
- Only one production variant is selected by default
- It is not allowed to rely on TUI for input, session-state for completion judgment, and other places for output.
## Local RPC design
It is recommended to use native JSON-RPC between `fire-controller` and `ai-runtime worker`.
Optional transmission:
- child process stdio
- Unix domain socket

First edition suggestions:
- child process stdio
- newline-delimited JSON

reason:
- Local and simple
- No additional ports required
- More suitable for fire pulling up and recycling workers
Message form:
```json
{"type":"request","id":"1","method":"session.open","params":{...}}
{"type":"response","id":"1","result":{...}}
{"type":"event","sessionId":"s1","event":{...}}
```

## Resume Design
###Resume exposed to the outside world
The Conductor storage layer should only save:
- `provider`
- `provider_variant`
- `resume_token`
- `resume_ready`
- `workspace`
- `model`
- Debug metadata
The `resume_token` here is an internal recovery token. It is not guaranteed to be readable by humans, nor is it guaranteed to be directly used to run the provider's own CLI.
### `resume_ready`

`resume_ready` is a clear field and no guessing is allowed.
For example:
- `codex-appserver`
-`thread/start` After:`resume_ready = false`
- After the first round of `turn/completed` and the session has been persisted: `resume_ready = true`
The logic of `fire-controller` at startup should be:
1. Read task binding2. If `resume_ready = true`, call `openSession({ resumeToken })`3. Otherwise fresh start
### Resume token principle
in principle:
- opaque
- provider-specific
- fire does not parse
- Interpreted only by provider adapter
### Manual CLI resume parameters
If a provider supports manual CLI resume, it must be exposed through separate information:
- `snapshot.manualResume`
- or `debug_metadata.manual_resume`
But `resume_token` cannot be allowed to take on this responsibility.
reason:
- Different providers have different internal recovery token semantics.
- In the same provider, "internally recoverable" and "external CLI recoverable" may not necessarily be true at the same time.
- Codex has verified that this difference exists: the thread id after `thread/start` can be used as an internal thread identifier, but it cannot immediately `codex resume`
## Runtime Status mapping
`fire-controller` only does unified mapping:
- `session.updated` -> runtime snapshot
- `turn.status` -> working status
- `turn.output.delta` -> assistant incremental message
- `turn.completed` -> assistant ends
- `turn.failed` -> Error message
What should not be done again:
- Extract semantics from provider-specific status line
- Spell out stages from session file or screen text
## Retry and recovery strategy
Recovery strategies are only allowed to be implemented inside `ai-runtime worker`.
suggestion:
- `provider_exited`
- If `resume_ready = true` and there is currently no active turn, it can automatically restart once
- If the current turn is in progress, mark the turn as `lost` or `failed`
- `network_unavailable`
- Short internal backoff of worker
- Throw unity error after timeout
- `auth_required`
- No automatic retries
- Enter `degraded`
- Send `auth.required`
- `rate_limited`
- Do not restart session
- Report directly
## Migration phase
The migration phase is promoted in two stages, consistent with the server's scope of influence.
### Phase 1: Only reconstruct the CLI/local link, without changing the server main protocol
Target:
- First set up the `fire -> ai-sdk -> ai-runtime` link.
- Do not change the current task/message/ack/runtime status main protocol.
- Remove `cli`'s direct dependence on `tui-driver` as soon as possible.
Contents of this stage:
- New `modules/ai-sdk`
- Define RPC, events, snapshots, error codes
- Provide fake provider to run through contract tests
- Implement `codex-appserver` provider
- `fire-controller` changed to rely only on `ai-sdk`
- Run through the main Codex path
- `tui-driver` is downgraded to `ai-sdk` internal transport and is no longer used directly by `cli`
Relationship with server:
- Do not modify the current message main protocol
- Existing task session binding is temporarily compatible for use
- Temporary mapping strategy:
- Internal `resume_token` staged to `session_id` in old field
- `provider_variant` puts metadata
- `manualResume` and debug fields put metadata
Phase 1 completion criteria:
- `fire-controller` no longer imports `tui-driver`
- Codex main path changed to `codex-appserver`
- Existing servers can run without supporting modifications
### Phase 2: Clean up the server session model and complete provider generalization
Target:
- Change session persistence from provider-specific model to provider-agnostic model
- Connect other providers to unified `ai-sdk`
Contents of this stage:
- server task session binding changed to generalized field-Introducing unified fields:
  
- `provider`
  
- `provider_variant`
  
- `resume_token`
  
- `resume_ready`
  
- `workspace`
  
- `model`
  
- `debug_metadata`
- Add heartbeat / degraded status as needed
- Implement `codex-appserver` provider
- Implement `codex-appserver` provider
- Select a single production variant per provider
- Exit `cli2sdk` from the task main path
- Remove remaining direct provider code in `fire`
Phase 2 completion criteria:
- `fire-controller` does not rely on provider-specific session fields at all
- The server persistence layer no longer assumes fixed field combinations such as `session_id/session_file_path/backend_type`
- All production providers are accessed through `ai-sdk`
## Acceptance criteria
After this reconstruction is completed, at least:
1. `tui-driver` import no longer appears in the `fire-controller` code.2. Provider-specific parameter assembly no longer appears in `fire-controller` code.3. Each provider variant has a clear single authority definition.4. Session crash will not directly cause the task connection to be disconnected.5. `resume_ready` has clear semantics and does not rely on guessing.6. Codex main path no longer depends on sqlite/session file discovery.7. There is an end-to-end functional test of the browser, covering the main link from the web app to the local AI session.
## Testing requirements
Testing must be done in four layers:
### Contract tests

- Perform fake provider test on `ai-sdk` public interface
- Override open/resume/sendTurn/interrupt/close
### Provider integration tests

- Each provider variant runs its own minimal real integration
- Verify resume, output, turn completion, usage, error
### Browser E2E functional tests

- Browser-based end-to-end functional testing must be added
- The test link covers at least:- web app creates or enters a task
- Send user messages
- See assistant incremental output in the browser
- See runtime status changes in the browser
- After the turn is completed, the page status will be closed correctly.
- In phase one, you can first use fake provider or deterministic provider as the main E2E base to ensure stability
- Phase 2 needs to supplement the real provider smoke E2E, at least covering the Codex main path
Recommended minimum coverage of browser scenarios:
- Create a new task and complete a round of dialogue
- After re-entering the page after disconnecting, the history and running status will be restored correctly.
- The page status is correctly closed after stopping the task
- Continue the conversation after session resume
- After the provider fails, the page receives a clear error instead of getting stuck silently.
### Soak tests

- Disconnect and reconnect fire and worker
- The provider process exited abnormally- session resume
- Long task stability
## Recommended conclusion
The conclusion is very clear:
- `fire` must degenerate into controller.- provider details must be dropped to standalone `ai-runtime worker`.
- `cli` should no longer depend directly on `tui-driver`.
- `codex-appserver` should become the default production path for Codex.
- Other providers must also be made explicit variants, and a single source of authority defined for each variant.
## Related documents
- `claw/rfc/0003-codex-app-server-usage.md`
- `claw/rfc/0002-codex-app-server-integration-plan.md`
- `claw/rfc/0004-daemon-fire-survivability-plan.md`

# AI SDK Architecture

This document describes the actual architecture of the current `modules/ai-sdk/` based on [RFC: `claw/rfc/0017-refactor-ai-sdk.md`](../rfc/0017-refactor-ai-sdk.md).

The conclusion after this convergence is simple:

- `ai-sdk` no longer assumes multi-provider compatibility layer
- `ai-sdk` no longer exposes resume/session-discovery helper
- `ai-sdk` only preserves local AI runtime boundaries
- Currently the only supported provider path is `codex app-server`

In other words, `ai-sdk` is now a narrower, cleaner module: it is responsible for isolating `fire-controller` from the native Codex runtime, rather than continuing to maintain TUI-era compatibility code internally.

## 1. Design goals

The goal of the RFC is to isolate the following two types of complexity:

- Remote task connection stability
- Complexity of local AI provider access

In the current implementation, `ai-sdk` has clearly accepted only the second type of complexity, and only the main Codex path.

The ideal link is still:

```text
web app
-> web server
-> fire-controller
-> ai-sdk client
-> ai-runtime worker
-> provider adapter
-> provider transport
-> local AI tool
```

Among them, `ai-sdk` currently covers the last four layers.

## 2. Current module boundary

The current structure of `modules/ai-sdk/src/` has been significantly reduced to the following pieces:

- `index.js`
- `client.js`
- `worker.js`
- `session-factory.js`
- `providers/codex-app-server-session.js`
- `providers/claude-agent-sdk-session.js`
- `providers/opencode-sdk-session.js`
- `transports/codex-app-server-transport.js`
- `transports/opencode-server-transport.js`
- `shared.js`

The responsibilities of each level are as follows.

### 2.1 Top-level export layer

- `index.js`

Now only export:

- `createAiSession`
- `RemoteAiSession`

This means that the public bounds of `ai-sdk` are no longer leaked:

- `TuiAiSession`
- provider-specific resume helper
- session path discovery helper
- Local session factory details

### 2.2 Client layer

- `client.js`

Responsibilities:

- Provide a unified session entrance for `fire-controller`
- Create independent worker processes by default
- Control workers via native RPC style messaging protocol
- Forward the session event and turn progress sent back by the worker

The current public entrance is still:

```js
createAiSession(backend, options)
```

But the `backend` here is no longer an open enumeration. Currently it only accepts:

- `codex`
- `claude`
- `opencode`

Other backends will be rejected directly at the `ai-sdk` boundary.

### 2.3 Runtime Worker layer

- `worker.js`

Responsibilities:

- Exists as an independent Node.js process
- Read newline-delimited JSON messages sent by the client
- Create a local session instance
- Forward provider session event
- Encapsulate errors back to client when worker crashes

The current message form is still a lightweight custom protocol:

- `create`
- `request`
- `response`
- `progress`
- `event`

This already satisfies the requirements for "control plane" and "local runtime" process isolation.

### 2.4 Session Factory layer

- `session-factory.js`

Responsibilities are now very simple:

- Normalized backend names
- Reject non-codex backend
- Create `CodexAppServerSession`

That is, this layer is no longer responsible for:

- Automatic provider variant switching
- TUI fallback
- provider-specific helper exposed

### 2.5 Provider Adapter and Transport

Currently there is only one official path:

```text
RemoteAiSession
-> worker
-> CodexAppServerSession
-> CodexAppServerTransport
-> codex app-server

RemoteAiSession
-> worker
-> ClaudeAgentSdkSession
-> claude agent-sdk

RemoteAiSession
-> worker
-> OpencodeSdkSession
-> OpencodeServerTransport
-> opencode sdk/server
```

The division of labor is as follows:

- `CodexAppServerSession`
  - Manage session boot, resume, turn life cycle
  - Map the underlying notification to the session / assistant / working status event that can be consumed by the upper layer
  - Maintain `sessionId`, `manualResumeReady`, usage related status

- `CodexAppServerTransport`
  - Pull up `codex app-server --listen stdio://`
  - Run JSON-RPC via stdio
  - Manage request/response, stderr tail, process exit

This is the provider layer currently closest to the goals of the RFC.

## 3. Current runtime topology

The default path is as follows:

```text
cli/fire
-> createAiSession()
-> RemoteAiSession
-> spawn(worker.js)
-> createLocalAiSession()
-> provider session
-> provider transport (if needed)
-> local AI tool
```

The key properties of this link are:

- `fire` does not directly touch the provider child process
- `fire` does not touch transport directly
- The crash of the local process will not directly kill the controller process.
- provider details are restricted to the worker process

If set:

```text
CONDUCTOR_AI_SDK_DISABLE_WORKER=1
```

Then `client` will bypass the worker and create a local session directly in the current process. This branch is mainly used for debugging and testing, not the main path.

## 4. Current public capabilities

Currently, `ai-sdk` still provides a transitional API to the upper layer, rather than the final `openSession()` interface in the RFC.

The exposed session capabilities mainly include:

- `ensureSessionInfo()`
- `getSessionUsageSummary()`
- `runTurn(promptText, options)`
- `setSessionReplyTarget(replyTo)`
- `setSessionMessageHandler(handler)`
- `setWorkingStatusHandler(handler)`
- `close()`

The current event is still an internal convention name, not the unified `AiSessionEvent` in the RFC:

- `session`
- `assistant_message`
- `working_status`
- `auth_required`
- `process.exited`
- `log`
- `worker_error`

So from an architectural perspective, `ai-sdk` has cleared the implementation layer transition code, but the public contract has not yet fully converged to the final schema of the RFC.

## 5. Transition code removed

In this convergence, `ai-sdk` has clearly removed the following categories of content.

### 5.1 TUI runtime

Removed:

- `src/tui-session.js`
- `@love-moon/tui-driver` dependency
- TUI provider fallback
- Environment variable switching logic for provider variant

Therefore `ai-sdk` is no longer maintained internally:

- PTY life cycle
- terminal signal polling
- session file polling output
- TUI profile selection

### 5.2 Resume / session discovery helper

**Update (2026-04):** resume is now owned by `ai-sdk` again, this time as a
proper per-provider contract rather than a monolithic CLI helper. All built-in
providers (codex, claude, copilot, kimi, opencode) and external providers
expose resume through the ai-sdk public API:

- `buildResumeArgsForBackend(backend, sessionId)`
- `resumeProviderForBackend(backend)`
- `resolveResumeContext(backend, sessionId, options)`
- `findSessionPath(provider, sessionId, options)`
- `resolveSessionRunDirectory(sessionPath)`
- `inspectResumeTarget(backend, sessionId, options)` (alias of `resolveResumeContext`)

Internally each provider has its own module under
`modules/ai-sdk/src/resume/<provider>.js` (codex, claude, copilot, kimi,
opencode). The shared dispatcher in `modules/ai-sdk/src/resume/index.js` walks
the built-in providers first and falls back to the external provider registry.
External provider descriptors may expose `resolveResumeContext` to opt in.

`cli/src/fire/resume.js` is now a thin facade that:

1. Delegates provider-specific lookups to `@love-moon/ai-sdk`.
2. Keeps Conductor-specific fallbacks (conductor session-record discovery for
   external backends, `allow_cli_list` alias normalization, `CONDUCTOR_CONFIG`
   handling).
3. Injects `lookupWorkspaceByHash` into the Kimi resolver so the CLI can walk
   `~/.conductor/sessions` to reconstruct Kimi workspace paths.

This means new providers added to ai-sdk automatically gain resume support by
exporting a resume module (and registering in the dispatcher), without having
to edit `cli/src/fire/resume.js`.

### 5.3 Leakage of top-level implementation details

`ai-sdk` top-level entry is no longer exported:

- `CodexAppServerSession`
- `createLocalAiSession`
- provider/session factory helper

This makes the top level of `ai-sdk` more like a real SDK rather than a collection of internal modules.

## 6. Boundaries with CLI

The current boundaries of responsibilities are much clearer than before.

### 6.1 `ai-sdk` is responsible

- worker process isolation
- Codex session life cycle
- Codex app-server transport
- turn execution with local event stream
- **provider-specific resume semantics** (session discovery, cwd extraction,
  CLI-arg shape, per-provider external resolver hooks)

### 6.2 `cli/fire` is responsible

- Conductor server communication
- task attach / ack / runtime status
- CLI-level resume orchestration (`--resume <id>` parsing, working directory
  switching, `CONDUCTOR_RESUME_CWD` override)
- Conductor-specific fallbacks: `allow_cli_list` alias resolution, conductor
  session-record lookup, Kimi workspace reconstruction hints

In other words, `cli` owns the "human-operable resume entry" and the
Conductor-specific policy; `ai-sdk` owns the "what each provider means by
resume" contract.

This is in line with the desired direction in the RFC:

- `ai-sdk` only handles local AI runtime
- `fire-controller` only handles the task control surface

### 6.2.1 Dependency direction (strict)

`@love-moon/ai-sdk` is the lower layer. The dependency arrow is one-way:

```
cli/ ─────────────► @love-moon/ai-sdk
modules/conductor-sdk/ (does not depend on ai-sdk)
```

- `ai-sdk` **MUST NOT** import anything from `cli/` or `modules/conductor-sdk/`.
  This includes transitive imports via session class files, worker.js, or
  resume modules.
- `cli/` **MAY** import from `ai-sdk` (e.g. `cli/src/runtime-backends.js`
  imports `BUILT_IN_BACKENDS` from `@love-moon/ai-sdk` to derive its alias set
  and run a module-load drift check).
- The reverse import is forbidden because `ai-sdk` is also published as a
  standalone npm package; depending on Conductor-specific code would tangle
  the runtime layer with the orchestration layer.

Violating this rule will likely surface as a circular-dependency error at
module load. If you find yourself wanting ai-sdk to know something that
currently lives in CLI, either (a) hoist it into `built-in-backends.js` (if
it's static metadata), or (b) pass it through as a callback in
`createAiSession` / `resolveResumeContext` options.

## 6.3 Adding a new built-in provider

The registry in `modules/ai-sdk/src/built-in-backends.js` is the **single
source of truth** for built-in backends. Alias resolution, variant selection,
and resume dispatch all read from it.

**Invariant: every built-in provider supports resume.** This is enforced at
module load by a self-check in `src/resume/index.js` — if you add a backend
to `BUILT_IN_BACKENDS` without registering a resume module, ai-sdk will throw
on import. If a provider's underlying runtime genuinely has no "resume" story,
it does not belong as a built-in; package it as an external provider instead.

Checklist — new built-in provider (e.g. `gemini`):

1. **Session class.** Create `src/providers/gemini-sdk-session.js` exporting
   a class with the usual duck-typed interface (`runTurn`, `close`,
   `ensureSessionInfo`, `getSessionInfo`, `getSnapshot`, ...). Look at
   `claude-agent-sdk-session.js` as a small reference and
   `opencode-sdk-session.js` as the heaviest reference.

2. **Register the backend in the central registry.** Add one entry to the
   `BUILT_IN_BACKENDS` array in `src/built-in-backends.js`:
   ```js
   { backend: "gemini", aliases: ["gemini", "gemini-cli"],
     defaultVariant: GEMINI_VARIANT }
   ```
   (Also export the `GEMINI_VARIANT` constant at the top of the file.) If
   the provider has a "structured output" variant, add `structuredVariant`.

3. **Wire the session factory.** Add one entry to
   `SESSION_FACTORIES_BY_BACKEND` in `src/session-factory.js`:
   ```js
   ["gemini", (backend, options) => new GeminiSdkSession(backend, options)],
   ```
   plus the corresponding `import` and re-export.

4. **Resume support (required).** Every built-in provider must support
   resume:
   - Create `src/resume/gemini.js` exporting `BACKEND`, `buildCliArgs`,
     `findSessionPath`, `resolveResumeContext`. Use the smallest existing
     module (`opencode.js`, 79 lines) as a template if the provider has no
     local session file.
   - Add one entry to `RESUME_MODULES_BY_BACKEND` in
     `src/resume/index.js`.

   Forgetting this step will cause ai-sdk to throw at module load —
   the invariant is machine-checked.

5. **Tests.**
   - `modules/ai-sdk/test/gemini-sdk-session.test.js` — turn / close /
     snapshot unit tests using a mocked SDK.
   - Extend `modules/ai-sdk/test/resume.test.js` with gemini resume cases.

**External providers** ship their own descriptor object via
`AISDK_PROVIDER_PATH`. For external providers, `resolveResumeContext`,
`buildResumeArgs`, and `findSessionPath` on the descriptor are optional —
external backends without resume simply raise "not supported" when
`--resume` is used against them. See
`modules/ai-sdk/fixtures/fake-resume-capable-provider.js` for the full
shape.

## 7. Current limitations

This refactoring is a "closure" and is not a full completion of the RFC.

Restrictions that still exist include:

- The top-level API is still `createAiSession(...)`, not the `openSession(OpenSessionOptions)` expected by the RFC
- The worker protocol is still embedded in `client.js` / `worker.js` and has not been split into independent `src/rpc/`
- Event and error models have not been unified into `AiSessionEvent` / `AiErrorInfo` in RFC
- snapshot has not yet converged into a unified schema defined by RFC
- The runtime supervisor is relatively light and does not have independent restart policy and health manager

So to be precise, the current status is:

- Realization boundaries have been tightened
- Public protocols need to continue to evolve

## 8. Recommended way of understanding

If you could summarize the current `ai-sdk` in just one sentence:

`ai-sdk` is now a codex-only local runtime module, rather than a multi-provider compatibility layer.

If we look at project maturity:

- Convergence completed
  - Remove `tui-driver`
  - Remove TUI fallback
  - Remove provider-specific resume helper exposure
  - Remove top-level implementation details and export

- Convergence that still needs to be completed
  - Unified session API
  - Unified events/errors/snapshot schema
  - Modularize the worker protocol
  - Further align the Codex path to the RFC's `AiSession` contract

## 9. Suggestions for subsequent evolution

According to the RFC, it is recommended to continue to do the following four things:

1. Extract the protocol between `client` / `worker` into an independent `rpc` module.
2. Replace the current handler style interface with `OpenSessionOptions` and standard snapshot/event.
3. Clear unified error codes and session/turn state machines for `CodexAppServerSession`.
4. Decide whether to reconnect to other providers in explicit variant mode instead of returning to the TUI compatibility layer.

In this way, we can move from "removing the transition code from the implementation" to "completely falling into the RFC for the protocol".

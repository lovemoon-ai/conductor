# Codex App Server usage record
Date:2026-03-08
Verification environment:
- `codex-cli 0.104.0`
- Native macOS arm64
This article only records the currently verified `codex app-server` usage and access precautions, and does not discuss Conductor code modification.
## in conclusion
Current local verification results:
- `codex app-server` can be used as the structured access interface of Codex.- `thread/start` will return stable `thread.id` and `thread.path`.- `turn/start` will continue to output structured events, which can directly drive the turn life cycle and incremental reply.- `codex resume <thread.id>` is not available immediately after `thread/start`.- `codex resume <thread.id>` can only be used after at least one real turn is completed and the session is placed into the saved session pool.- `ephemeral` thread should not be considered a CLI resumeable session.
## Startup method
### stdio

```bash
codex app-server --listen stdio://
```

The `stdio://` transmission observed by the local `0.104.0` is line-by-line JSON, not `Content-Length` framing like LSP.
Recommendations when accessing:
- Prioritize implementation by JSONL.- Keep protocol probes and version logs within the adapter.- Don't leak framing details to the fire/controller layer.
### WebSocket

```bash
codex app-server --listen ws://127.0.0.1:43123
```

Suitable for local debugging, not recommended as the default path for Conductor production.
reason:
- One more layer of port management.- One more layer of connection status.- Nothing is more stable for fire than local stdio.
## Minimum life cycle
Minimum working calling sequence:
1. `initialize`
2. `initialized`
3. `thread/start`
4. `turn/start`
5. Wait for `turn/completed`6. Continue with `turn/start`, or go to `thread/resume`
### initialize

Request example:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"probe","version":"1.0.0"},"capabilities":{"experimentalApi":true}}}
```

Response example:
```json
{"id":1,"result":{"userAgent":"probe/0.104.0 (...omitted...)"}}```

### thread/start

Request example:
```json
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"<repo-root>","ephemeral":false}}
```

Key return fields observed natively:
```json
{
  "id": 2,
  "result": {
    "thread": {
      "id": "019ccda5-1b88-7d81-87ac-f0d381a8abcf",
      "path": "<codex-home>/sessions/2026/03/08/rollout-2026-03-08T21-31-15-019ccda5-1b88-7d81-87ac-f0d381a8abcf.jsonl",
      "cwd": "<repo-root>",
      "source": "vscode"
    }
  }
}
```

You will also receive:
```json
{"method":"thread/started","params":{"thread":{"id":"019ccda5-1b88-7d81-87ac-f0d381a8abcf","path":"...jsonl"}}}
```

Currently validated reliable fields:
- `thread.id`
- `thread.path`
- `thread.cwd`

## turn/start

Request example:
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "turn/start",
  "params": {
    "threadId": "019ccda5-1b88-7d81-87ac-f0d381a8abcf",
    "input": [
      {
        "type": "text",
        "text": "Reply with exactly OK"
      }
    ]
  }
}
```

Key events observed on this machine:
- `turn/started`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `thread/tokenUsage/updated`
- `account/rateLimits/updated`
- `turn/completed`

Among them, `item/agentMessage/delta` can be directly used as the assistant incremental output source.
Example:
```json
{"method":"item/agentMessage/delta","params":{"threadId":"019ccda5-1b88-7d81-87ac-f0d381a8abcf","turnId":"019ccda5-1b8c-76b1-b3b7-7f11d70a9f90","itemId":"msg_xxx","delta":"OK"}}
```

Final completion event:
```json
{"method":"turn/completed","params":{"threadId":"019ccda5-1b88-7d81-87ac-f0d381a8abcf","turn":{"id":"019ccda5-1b8c-76b1-b3b7-7f11d70a9f90","status":"completed","error":null}}}
```

## Current status of `session_configured`
`sessionConfigured` / `session_configured` related definitions exist in the protocol schema and include:
- `session_id`
- `rollout_path`

But in the minimum verification process of this machine `0.104.0`:
- `thread/start`
- `turn/start`
- `turn/completed`

The event was not actually observed during this period.
Therefore the current access recommendations are:
- Do not use `session_configured` as a necessary prerequisite for the main path of the Codex app-server.- The currently stable and available session ID first uses `thread.id`.- `thread.path` saved as debugging and supplemental metadata.- `thread.id` can be used as a source for manual CLI resume parameters, but should not be directly equivalent to `ai-sdk`'s internal `resume_token`
## Resume behavior
There are two sets of resumes to distinguish here.
### app-server internal resume
Protocol layer support:
```json
{"jsonrpc":"2.0","id":4,"method":"thread/resume","params":{"threadId":"019ccda5-1b88-7d81-87ac-f0d381a8abcf"}}
```

This should serve as the main resume path within Conductor.
reason:
- It is the same protocol plane as `thread/start` / `turn/start`.- Not dependent on TUI.- Does not rely on CLI picker.
### CLI `codex resume`

Actual verification results on this machine:
- Execute immediately after just doing `thread/start`:
```bash
codex resume 019ccda3-9e14-7453-909a-87d63e4ae64a
```

return:
```text
ERROR: No saved session found with ID 019ccda3-9e14-7453-909a-87d63e4ae64a.
```

- After completing at least one round of real `turn/start -> turn/completed` on the same `thread.id`, execute:
```bash
codex resume 019ccda5-1b88-7d81-87ac-f0d381a8abcf
```

CLI can enter the session normally and will prompt: when exiting.
```text
To continue this session, run codex resume 019ccda5-1b88-7d81-87ac-f0d381a8abcf
```

So a more accurate conclusion is:
- `thread.id` does not mean that the saved session id of `codex resume` is immediately available.- `thread.id` can become a parameter of `codex resume` after session persistence is completed.- For Conductor, the manual CLI resume parameters and the internal `resume_token` should be modeled separately.
### `ephemeral`

`thread/start` supports:
```json
{"ephemeral": true}
```

The protocol schema also states:
- `rollout_path` for ephemeral thread can be `null`
therefore:
- `ephemeral` thread should not be exposed as a restorable session.- `resume_ready` must be `false`.
## Suggestions for accessing Conductor
### Main access method
For Codex, the recommended order is:
1. `codex app-server --listen stdio://`
2. `initialize`
3. `thread/start` with `ephemeral: false`
4. Save `thread.id`5. Use `turn/start` to drive all turns6. Use `thread/resume(threadId)` for internal recovery
### Fields saved as session bindings
It is recommended to save:
- `provider = codex`
- `provider_variant = codex-appserver`
- `resume_token = provider-private opaque token`
- `manual_resume.command = codex resume <thread.id>`
- `manual_resume.ready = false` initial value- `debug.thread_path = thread.path`
- `manual_resume.ready = false` initial value
Switch after the first round of `turn/completed`:
- `resume_ready = true`
- `manual_resume.ready = true`

### Fields used as output authoritative sources
Recommended use:
- Incremental output: `item/agentMessage/delta`- turn closing: `turn/completed`- token/context:`thread/tokenUsage/updated` and `account/rateLimits/updated`
It is not recommended to use:
- TUI screen capture- sqlite session discovery
- rollout file existence as a prerequisite for turn success
## Points that are currently unverified
As of 2026-03-08, this machine has not completed the following verifications:
- `thread/resume` Whether the same thread can be stably restored after the app-server process is restarted- Under which versions or parameters will `session_configured` actually be emitted?- Whether `thread.path` remains stable after multiple rounds of turns- Complete event chain of tool approval / file change approval
These points require special integration testing when they are actually connected to `ai-sdk`.
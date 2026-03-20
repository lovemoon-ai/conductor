# PTY direct transport writer cannot retry stably after switching

## Symptoms
- The user can upgrade to direct transport for the first time in the PTY task, but then other viewers take away control. After getting back the writer, the terminal often can only stop at relay / fallback_relay.
- In some cases, terminal detach, interruption, or occasional direct path failure may occur during the direct negotiation process.
- In a multi-viewer scenario, after the direct writer is upgraded, other viewers may not be able to see the latest output, and the PTY latency on the diagnostic screen will also stop updating.

## Root Cause
- TerminalView bound the terminal initialization effect to the transport state in the early stage. When the direct negotiation triggers the state switch, cleanup will be executed by mistake and `terminal_detach` will be sent.
- In the early days, the daemon directly short-circuited after the direct output was successful, and no longer continued to relay `terminal_output` to the backend, destroying the multi-viewer semantics and diagnostics latency sampling link.
- Writer ownership and direct data plane were not fully linked in the early stage: after the old writer was takenover / released / disconnected, the old direct channel was not revoke in time.
- The PTY transport session id of the same app connection is reused for a long time, resulting in no new direct negotiation epoch for the same connection after getting the writer back, and the client will skip retrying.

## Fix
- Decouple the terminal initialization effect of TerminalView from the transport state. Direct negotiation only cleans up RTC resources and no longer sends `terminal_detach` by mistake.
- The daemon will continue to relay `terminal_output` to the backend when the direct output is successful, preserving multiple viewer and diagnostics paths.
- app-gateway issues `revoke` to the daemon when the writer takesover / release / detach / disconnect, and the daemon presses `(taskId, sessionId, connectionId)` to verify the validity of the direct channel.
- When the writer is actually re-granted to a connection, the server refreshes the PTY transport `session_id` of the connection, issues a new relay epoch, and allows the client to renegotiate direct.
- Supplement direct negotiation, writer revoke/takeover, direct+relay coexistence, session epoch retry and other regression tests.

## Prevention
- All React effects driven by "control plane state" must clearly distinguish between "resource initialization/destruction" and "state synchronization" to avoid cleanup hanging on high-frequency states.
- For any direct path optimization, the relay observation link is required to be retained by default, unless the system semantics are explicitly changed to single viewer/no diagnosis.
- Ownership changes must review the control plane and data plane simultaneously: writer switching, detach, disconnect, and reconnect must have revoke / epoch / stale-channel tests.
- Do not reuse session epochs for a long time for negotiation protocols; if you reuse connections, at least provide a new negotiation epoch when ownership switches back.
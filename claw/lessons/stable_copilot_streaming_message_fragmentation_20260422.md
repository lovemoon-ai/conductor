# Symptom

Copilot SDK streaming replies were emitted as multiple standalone assistant messages, so one response could render as several chat bubbles.

# Root Cause

`assistant.message_delta` was forwarded directly as committed assistant output, while the final `assistant.message` was suppressed once streaming had been seen. Conductor fire and web treat each `session_stream` message as a separate reply, so delta chunks were rendered independently.

# Fix

Buffer Copilot message deltas by `messageId`, keep using them only for progress preview, and emit assistant output once from the final `assistant.message` or a completion fallback when no final event arrives.

# Avoid Next Time

When integrating provider streaming, first verify whether downstream consumers support append semantics or only discrete messages. If the transport is discrete, keep chunk events inside the provider adapter and only emit committed messages to the rest of the system.

# Symptom

Closing a Copilot-backed session could hang conductor fire shutdown if SDK disconnect or stop never returned.

# Root Cause

The main Copilot session close path awaited `session.disconnect()` and `client.stop()` without a timeout or forced fallback, unlike the quota and resume cleanup paths.

# Fix

Wrap Copilot session disconnect and client stop in bounded timeouts and fall back to `client.forceStop()` when graceful cleanup hangs or fails.

# Avoid Next Time

Any long-lived provider transport should have one shared cleanup policy for normal session shutdown, startup-abort cleanup, and diagnostic helpers. If one path needs timeout-plus-force-stop, the others almost certainly do too.

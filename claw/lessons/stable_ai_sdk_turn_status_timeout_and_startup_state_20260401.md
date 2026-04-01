## Symptom

- Long-running AI turns could fail with `Turn exceeded hard deadline (720s)` even while the provider was still emitting progress.
- Callers could not reliably query the current turn state from `ai-sdk`.
- Fresh turns could briefly expose the previous turn's terminal state.
- Some startup failures left the cached turn state stuck at `turn_started`.

## Root Cause

- Turn timeout logic was a pure wall-clock deadline instead of a progress-freshness timeout.
- Working-status updates were event-only; there was no queryable `currentTurnStatus` snapshot.
- Provider-local `updated_at` timestamps were not consistently propagated through worker-backed sessions.
- Providers only transitioned into a visible turn state after downstream async events arrived.
- Optimistic `turn_started` markers were written before boot/session startup without guaranteed failure settlement.

## Fix

- Added `getCurrentTurnStatus()` and `snapshot.currentTurnStatus` across local and remote `ai-sdk` sessions.
- Changed provider timeout guards to use recent turn activity instead of only absolute elapsed time.
- Propagated `updated_at` through provider, worker, and remote session boundaries.
- Marked new turns as `turn_started` immediately when a turn begins.
- Settled startup failures into `turn_failed` so cached state does not remain in-progress.
- Added regressions for worker-backed snapshots, stale-progress timeout behavior, Kimi dedupe refreshes, and startup failure convergence.

## Prevention

- Any new provider state field must be tested through both direct-session and worker-backed session paths.
- When publishing optimistic in-progress state, always define and test the corresponding early-failure terminal path.
- Timeout logic for streamed/agentic providers should key off recent observable progress, not just wall-clock duration.

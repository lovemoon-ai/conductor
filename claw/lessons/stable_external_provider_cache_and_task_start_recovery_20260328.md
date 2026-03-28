# External provider cache poisoning and task-start recovery bug

## Symptom
- A transient bad external provider module could poison backend discovery for the life of the process.
- After certain pre-spawn daemon failures, task creation could get stuck until the daemon restarted.
- These failures were intermittent and recovery depended on process restart instead of normal retry behavior.

## Root cause
- External provider loaders cached rejected promises, so later retries reused the original failure even after the module became valid.
- Daemon task-start bookkeeping was not cleared on every failure path before process spawn completed.
- The code optimized for happy-path memoization but did not treat failed initialization as retryable state.

## Fix
- Clear cached loader promises on failure in both CLI runtime backend discovery and ai-sdk external provider registry.
- Add cache-busting dynamic imports for external provider modules so same-path reloads can succeed after repair.
- Ensure daemon pending task-start state is cleaned up through failure-safe paths so retries can proceed.
- Add regression tests for invalid-then-valid provider reloads and pre-spawn task creation recovery.

## How to avoid next time
- Never memoize failed initialization forever unless restart-only recovery is explicitly intended.
- For loader caches, test the repair path, not just first-load success.
- For daemon lifecycle guards, use cleanup patterns that run on every exit path, especially before child process spawn has succeeded.

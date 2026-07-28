# Code review: bounded task mutations and auth session retention

## Findings

### Resolved P2: over-broad Prisma `P2028` classification

The first implementation mapped every Prisma `P2028` to retryable
`archive_busy`. `P2028` also represents expired or closed transactions, which
must not be presented as ordinary transaction-start contention.

Resolution:

- `web/src/app/api/tasks/[taskId]/achieve/route.ts` now requires both `P2028`
  and the confirmed `Unable to start a transaction in the given time` message.
- Other `P2028` variants keep the unexpected 5xx path and receive contextual
  logging.
- Route tests cover both startup contention and expired transaction behavior.

### Resolved P2: client timeout could refill the queue before server teardown ends

The frontend queue limits unresolved browser promises to three, but the shared
15-second timeout could abort those promises while their server handlers were
still finishing, allowing the queue to launch replacements.

Resolution:

- Archive and delete now use a dedicated 60-second client timeout.
- The global API timeout remains 15 seconds.
- Store tests verify both mutation calls pass the extended timeout.

Residual risk: browser-side limits cannot prove a strict distributed
server-wide concurrency cap if a handler remains alive beyond 60 seconds. A
durable server-side batch queue is still the correct future design for
unbounded or cross-client workloads. The current teardown has bounded daemon
acknowledgement and Prisma transaction timeouts, so 60 seconds covers the
confirmed incident while keeping this fix surgical.

### Resolved P2: selection mutation race during a batch

Task-card selection remained interactive while archive/delete ran. Completion
then replaced selection with the failed IDs, potentially overwriting user
changes made during the operation.

Resolution:

- `toggleTaskSelection` ignores input while a selection action is busy.
- Both archive and delete buttons remain disabled for the entire batch.
- Component tests verify a busy selection callback does not render a state
  change and repeated action clicks do not submit again.

### Resolved P2: incomplete batch behavior coverage

The initial tests proved the first three calls but did not cover progress
advancement, archive/delete mutual exclusion, double submission, or delete
timeout no-retry behavior.

Resolution:

- The 70-task widget tests now assert progress moves from 0 to 3.
- Both actions are asserted disabled while either queue runs.
- Repeated clicks do not reopen confirmation or enqueue work.
- A simulated delete timeout completes with exactly 70 calls and retains only
  the failed task.

### Resolved P3: incomplete archive outcome logging

Expected teardown rejection and unexpected teardown exceptions lacked
task/project duration context.

Resolution:

- Success, transaction-start contention, expected rejection, and unexpected
  errors now emit contextual terminal logs.

### Resolved P3: progress observer could interrupt queue execution

An exception in the optional progress observer could stop a worker and leave
items unprocessed.

Resolution:

- Observer exceptions are isolated from mutation execution.
- A unit test verifies every worker still runs when progress reporting throws.

### Resolved P3: stale recoverable auth error

A successful user refresh did not clear a prior transient authentication error.

Resolution:

- Initialization clears stale errors when retrying.
- Successful `fetchUser` clears the previous error.
- Tests cover JWT-only recovery and successful refresh after a transient error.

## Final assessment

No blocking problem found after the review fixes.

The implementation preserves user scoping, keeps the single-task endpoints
backward compatible, and does not change database schema or persisted data
formats. The main residual risk is that browser concurrency is not a global
server semaphore; this is explicitly mitigated by the operation-specific
timeout and deferred to a durable batch-job design if workload size grows.

## Verification

- Focused tests: 5 files, 70 tests passed.
- Full Web test suite: passed using an isolated temporary SQLite database.
- Production build: passed (`pnpm build`).
- Code review performed across architecture/API/data, authentication/security,
  concurrency/performance/UI, and test coverage.

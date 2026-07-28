---
type: stable
date: 2026-07-28
area: web-task-batch-actions
---

# Batch archive transaction storm caused false logout

## Symptom

Archiving more than 70 tasks from one project caused most archive requests to
fail or time out. The browser then returned the user to the login flow even
though the stored JWT was still valid. Batch deletion had the same unbounded
request pattern and could trigger an equivalent failure.

## Root cause

`TaskList` started one archive or delete request per selected task with
`Promise.allSettled` or `Promise.all`. A 79-task archive therefore created 79
concurrent teardown operations. Those operations competed for Prisma interactive
transactions and produced `P2028` transaction-start timeouts. The API client
aborted remaining requests after 15 seconds.

The authentication store independently treated every `/auth/me` failure as an
invalid token. A timeout, network failure, or HTTP 5xx during the transaction
storm therefore cleared a valid persisted session. Production logs later showed
`/api/auth/me` returning HTTP 200 with the same credentials.

## Fix

- Run task archive and delete operations through a shared settled-result queue
  with a maximum of three active requests.
- Give archive/delete requests a dedicated 60-second client timeout so the queue
  does not replace a timed-out request while its server teardown is likely still
  active; keep the global API timeout unchanged.
- Keep successful mutations and retain only failed tasks in the selection.
- Show batch progress and partial-failure counts.
- Clear authentication state only for an explicit HTTP 401. Preserve the session
  and expose a recoverable error for timeouts, network failures, 429, malformed
  responses, and 5xx responses.
- Map Prisma `P2028` from the archive route to a typed retryable HTTP 503 response.
- Cover both archive and delete with 70-task concurrency tests.

## Prevention

- Never fan out a user-sized collection directly into database-writing API
  requests without an explicit concurrency bound.
- Test bulk UI actions at realistic upper-bound sizes, not only with two items.
- Keep authentication invalidation separate from transport and service
  availability errors.
- Preserve idempotency for operations that clients may retry after an ambiguous
  timeout.
- Monitor 499, 5xx, Prisma transaction timeout, and unexpected logout signals
  together when diagnosing bulk-operation failures.

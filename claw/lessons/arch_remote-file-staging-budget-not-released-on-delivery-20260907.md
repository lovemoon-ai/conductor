# arch: a resource budget that is charged at reserve time but never released on success

## Symptom

`conductor remote cp` refused to start new transfers after roughly 2 GiB of
**successful** traffic:

```
Error: remote file staging budget exhausted for this account
(limit 2147483648 bytes); finish or cancel a transfer and retry
```

Two completed 1 GB uploads were enough. Once the headroom was gone, *every*
size failed — a 1 KB copy included — for the rest of the 15-minute record TTL.
The message told the user to "finish or cancel a transfer" when there was no
in-flight transfer and the staging directory was empty.

## Root cause

`reservedBytes()` in `web/src/lib/transfers/transfer-store.ts` charged a
record's bytes to the per-user budget whenever the record was live **or** in
`ready`:

```ts
if (record.status === "ready") total += record.receivedBytes;
```

The intent was right — a finished transfer whose blob is still on disk must
keep costing budget, or the cap would bound concurrency instead of storage.
But `ready` means two different things depending on direction:

| direction | `ready` means | is there still a reader? |
| --- | --- | --- |
| `down` | bytes are fetchable by the CLI | **yes** — the CLI still has to GET them |
| `up` | the daemon already wrote them to `remotePath` | **no** — nothing will ever read the blob again |

For an upload the staged blob became dead weight the instant delivery
succeeded, but it was kept — and charged — until the TTL sweep. So the 2 GiB
per-user budget silently stopped being a concurrency bound and became a
*rolling 2 GiB of cumulative volume per 15 minutes* quota.

The unit tests did not catch it because one of them asserted the buggy
behaviour directly: `keeps counting a finished transfer's bytes until its blob
is gone` was written with `direction: "up"`, so it pinned exactly the case that
should have released.

## Fix

Release the blob and the charge as soon as a delivered upload reaches `ready`,
centralised in `updateTransfer` so no future call site can forget it:

```ts
if (record.status === "ready" && record.direction === "up" && !record.blobReleased) {
  record.blobReleased = true;
  void releaseTransferBlob(record.transferId);
}
```

A new `blobReleased` flag makes `reservedBytes()` skip the record. The record
itself survives so the client's status poll still resolves `ready`, and
re-issuing `POST /deliver` on a released transfer is answered idempotently
rather than sending the daemon to a 404.

Downloads are untouched: their `ready` blob must stay until the CLI fetches it.

## How to avoid this next time

1. **A reservation needs an explicit release path per terminal state, not just
   a TTL.** A TTL is a backstop for crashes, not the mechanism. If the only
   thing that returns budget is the sweep, the budget is a rate limit wearing a
   concurrency limit's error message.
2. **Watch for one status meaning different things on different code paths.**
   `ready` was shared between upload and download with opposite implications
   for whether a consumer remains. When a state is reused across directions,
   assert per direction — the type system will not do it for you.
3. **A test that pins the current behaviour is not the same as a test that
   pins the intended behaviour.** The `up`-direction test read as coverage but
   locked in the defect. When writing a test for "resource still held", also
   write its twin for "resource released", and make sure each uses the
   direction where its reasoning actually applies.
4. **Quota errors should be reachable only when the advice in them is
   actionable.** "finish or cancel a transfer and retry" was impossible to act
   on, which is a strong hint the accounting — not the user — was wrong. If an
   error tells the user to do something they cannot do, treat it as a bug
   report about the check.
5. **Exercise budgets with repetition, not just size.** The single-transfer
   cases all passed; only back-to-back transfers exposed it. Any cap deserves a
   loop test that runs past it several times over.

## Verification

- `web`: 231 files / 2167 tests pass, including two new regression tests that
  both fail without the fix.
- E2E against a live local server and the real CLI: five consecutive 1000 MB
  uploads (5 GB cumulative, 2.5× the budget) all succeed, sha256 identical, and
  the staging directory stays empty. Downloads still resume and verify.
